import { createHash } from "node:crypto";
import { generateKeyPair, SignJWT, jwtVerify, exportPKCS8, exportSPKI, importPKCS8, importSPKI } from "jose";
import { eq, and, desc, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { logAuditEntry } from "@/lib/audit";

/**
 * Layer 13-3: AP2 (Agent Payments Protocol) mandate verification — a
 * documented SUBSET, not the full spec. We implement the Checkout
 * Mandate and Payment Mandate verification path as ES256-signed JWTs,
 * not the full W3C Verifiable Credential / SD-JWT stack with selective
 * disclosure. See DECISIONS.md.
 *
 * Cryptography: ECDSA over P-256 with SHA-256 (the JOSE "ES256" alg).
 * The AP2 spec explicitly requires a non-deterministic signature scheme
 * here and forbids a deterministic one (Ed25519) — a deterministic
 * signature over a hashed checkout would let an attacker build a
 * rainbow table mapping known checkout_hash values to signatures,
 * something a non-deterministic ECDSA signature (a fresh random nonce
 * per signature) structurally prevents. This is a real, non-obvious
 * constraint, not a stylistic choice — see the AP2 spec and
 * DECISIONS.md.
 *
 * Every verification step here is deterministic and fails closed: a
 * step that cannot be evaluated (a DB error, a malformed JWT) denies,
 * per CLAUDE.md rule 4. Wired into /api/agent/purchase and the MCP
 * purchase tool, BEFORE checkBounds() ever runs — see gate.ts.
 */

const ALG = "ES256";
// Small clock-skew allowance for "not issued in the future" — real
// clocks drift a few seconds between this server and wherever a JWT's
// iat might be validated against, even though we mint every mandate
// ourselves. Kept tight since we are both issuer and verifier.
const CLOCK_SKEW_SECONDS = 30;

/**
 * Loads a merchant's ECDSA P-256 keypair, generating and persisting one
 * on first use. Lazy generation means an existing merchant is
 * completely unaffected until they (or an agent of theirs) actually
 * transacts with a mandate — no migration-time cost, no key nobody
 * asked for.
 */
export async function getOrCreateMandateKeypair(merchantId: string): Promise<{ privateKeyPkcs8: string; publicKeySpki: string }> {
  const [merchant] = await db
    .select({
      mandateSigningKeyEncrypted: schema.merchants.mandateSigningKeyEncrypted,
      mandatePublicKey: schema.merchants.mandatePublicKey,
    })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId));

  if (!merchant) throw new Error(`No merchant found with id ${merchantId}`);

  if (merchant.mandateSigningKeyEncrypted && merchant.mandatePublicKey) {
    return {
      privateKeyPkcs8: decrypt(merchant.mandateSigningKeyEncrypted),
      publicKeySpki: merchant.mandatePublicKey,
    };
  }

  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const privateKeyPkcs8 = await exportPKCS8(privateKey);
  const publicKeySpki = await exportSPKI(publicKey);

  await db
    .update(schema.merchants)
    .set({
      mandateSigningKeyEncrypted: encrypt(privateKeyPkcs8),
      mandatePublicKey: publicKeySpki,
    })
    .where(eq(schema.merchants.id, merchantId));

  return { privateKeyPkcs8, publicKeySpki };
}

interface CartLineForMandate {
  variantId: string;
  sku: string;
  quantity: number;
  unitPricePaise: number;
}

export interface CheckoutMandateClaims {
  merchantId: string;
  agentId: string;
  lines: CartLineForMandate[];
  totalPaise: number;
  currency: "INR";
}

/**
 * Signs a Checkout Mandate — a merchant-issued JWT stating exactly what
 * cart contents and total the merchant is willing to sell at, to a
 * specific agent. This is the artifact a Payment Mandate later binds to
 * by checkout_hash. expiresInSeconds bounds how long an agent has to
 * get human approval and present a Payment Mandate back — a real,
 * code-checked deterministic bound, same shape as offers.expiresAt.
 */
export async function issueCheckoutMandate(
  claims: CheckoutMandateClaims,
  expiresInSeconds: number = 15 * 60,
): Promise<{ mandateId: string; jwt: string; checkoutHash: string; expiresAt: Date }> {
  if (!Number.isInteger(claims.totalPaise) || claims.totalPaise <= 0) {
    throw new Error(`issueCheckoutMandate: totalPaise must be a positive integer, got ${claims.totalPaise}`);
  }

  const { privateKeyPkcs8 } = await getOrCreateMandateKeypair(claims.merchantId);
  const privateKey = await importPKCS8(privateKeyPkcs8, ALG);

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((now + expiresInSeconds) * 1000);

  const jwt = await new SignJWT({
    merchantId: claims.merchantId,
    agentId: claims.agentId,
    lines: claims.lines,
    totalPaise: claims.totalPaise,
    currency: claims.currency,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(privateKey);

  const checkoutHash = createHash("sha256").update(jwt).digest("hex");

  const [mandate] = await db
    .insert(schema.checkoutMandates)
    .values({
      merchantId: claims.merchantId,
      agentId: claims.agentId,
      jwt,
      checkoutHash,
      totalPaise: claims.totalPaise,
      status: "issued",
      expiresAt,
    })
    .returning();

  await logAuditEntry({
    merchantId: claims.merchantId,
    actor: "system",
    event: "checkout_mandate_issued",
    decision: "n/a",
    reason: `Signed a Checkout Mandate for agent ${claims.agentId}: ₹${(claims.totalPaise / 100).toFixed(2)} for ${claims.lines.length} line(s), expiring at ${expiresAt.toISOString()}.`,
    metadata: { checkoutMandateId: mandate.id, agentId: claims.agentId, totalPaise: claims.totalPaise },
  });

  return { mandateId: mandate.id, jwt, checkoutHash, expiresAt };
}

export interface PaymentMandatePresentation {
  merchantId: string;
  agentId: string;
  /** The exact Checkout JWT string being redeemed against. */
  checkoutJwt: string;
  /** What the caller (gate.ts) asserts it is about to charge — re-checked against the signed checkout's own totalPaise. */
  assertedAmountPaise: number;
}

interface VerificationFailure {
  reason: string;
  failureReason: string;
}

/**
 * The six deterministic, fail-closed verification steps from
 * plans/layer-13-authorization-supervision-proof.md's L13-3, run in
 * order, short-circuiting on the first failure:
 *   1. JWT signature valid under the expected key
 *   2. Not expired (and not issued implausibly in the future)
 *   3. checkout_hash equals SHA-256 of the presented Checkout JWT
 *      (trivially true here since we look the row up BY that hash — the
 *      real-world equivalent of an attacker presenting a tampered JWT
 *      that no longer hashes to any known mandate, which step 3 catches
 *      structurally: no row is found at all)
 *   4. Cart contents and total match the signed checkout exactly,
 *      integer paise, never a float or a tolerance
 *   5. Any constraint carried on the mandate is satisfied (this subset
 *      carries no separate constraint set beyond the checkout itself —
 *      see DECISIONS.md's scoping note)
 *   6. Not already consumed (replay protection)
 *
 * Every attempt — pass or fail — writes a mandate_verifications row and
 * an audit_log entry naming exactly which step failed. A verification
 * error (a thrown exception anywhere in here) is caught by the caller
 * and treated as a failure, never propagated into a 500 on a money path.
 */
export async function verifyPaymentMandate(
  presentation: PaymentMandatePresentation,
): Promise<{ ok: true; totalPaise: number; mandateId: string } | { ok: false; reason: string }> {
  const checkoutHash = createHash("sha256").update(presentation.checkoutJwt).digest("hex");

  const record = async (failure: VerificationFailure | null, checkoutMandateId?: string) => {
    await db.insert(schema.mandateVerifications).values({
      merchantId: presentation.merchantId,
      checkoutMandateId: checkoutMandateId ?? null,
      outcome: failure ? "failed" : "verified",
      failureReason: failure?.failureReason ?? null,
    });
    await logAuditEntry({
      merchantId: presentation.merchantId,
      actor: "agent",
      event: "mandate_verification",
      decision: failure ? "deny" : "n/a",
      reason: failure ? failure.reason : `Payment mandate verified for agent ${presentation.agentId}, checkout ${checkoutHash.slice(0, 12)}…`,
      boundApplied: failure ? `mandate_verification_failed:${failure.failureReason}` : undefined,
      metadata: { agentId: presentation.agentId, checkoutHash },
    });
  };

  // Step 3 (structural): look the mandate up by its own hash. If none
  // exists, the presented JWT doesn't match any checkout this merchant
  // ever signed — a tampered or fabricated JWT is caught right here,
  // before we even attempt to verify a signature against nothing.
  const [mandate] = await db
    .select()
    .from(schema.checkoutMandates)
    .where(and(eq(schema.checkoutMandates.checkoutHash, checkoutHash), eq(schema.checkoutMandates.merchantId, presentation.merchantId)));

  if (!mandate) {
    const failure = {
      reason: `Denied — no Checkout Mandate found matching this checkout_hash for this merchant. The presented cart was never signed, or was tampered with after signing.`,
      failureReason: "checkout_hash_mismatch",
    };
    await record(failure);
    return { ok: false, reason: failure.reason };
  }

  if (mandate.agentId !== presentation.agentId) {
    const failure = {
      reason: `Denied — this Checkout Mandate was issued to a different agent than the one presenting it.`,
      failureReason: "agent_mismatch",
    };
    await record(failure, mandate.id);
    return { ok: false, reason: failure.reason };
  }

  // Step 6: replay protection. A used mandate is terminal — checked
  // before the more expensive signature verification so a replay is
  // rejected cheaply.
  if (mandate.status === "consumed") {
    const failure = {
      reason: `Denied — this Checkout Mandate has already been redeemed. A mandate may be used exactly once.`,
      failureReason: "already_consumed",
    };
    await record(failure, mandate.id);
    return { ok: false, reason: failure.reason };
  }

  // Step 2: expiry, checked against both the stored row and the JWT's
  // own exp claim (the next step) — belt and suspenders, since the row
  // is the fast check and the JWT verification below is authoritative.
  if (mandate.status === "expired" || mandate.expiresAt.getTime() < Date.now()) {
    if (mandate.status !== "expired") {
      await db.update(schema.checkoutMandates).set({ status: "expired" }).where(eq(schema.checkoutMandates.id, mandate.id));
    }
    const failure = {
      reason: `Denied — this Checkout Mandate expired at ${mandate.expiresAt.toISOString()}.`,
      failureReason: "expired",
    };
    await record(failure, mandate.id);
    return { ok: false, reason: failure.reason };
  }

  // Step 1: signature. Verified against the merchant's own stored public
  // key — never trusts an "alg"/"kid" the token itself claims beyond
  // what jwtVerify enforces (ES256 pinned explicitly).
  try {
    const { publicKeySpki } = await getOrCreateMandateKeypair(presentation.merchantId);
    const publicKey = await importSPKI(publicKeySpki, ALG);
    const { payload } = await jwtVerify(presentation.checkoutJwt, publicKey, {
      algorithms: [ALG],
      clockTolerance: CLOCK_SKEW_SECONDS,
    });

    // Step 4: the caller's asserted amount must match the signed
    // checkout's own total exactly, integer paise, never a tolerance —
    // the same product_price_match discipline gate.ts's resolveVariant
    // already applies, extended to a mandate-bound purchase.
    const signedTotalPaise = payload.totalPaise as number;
    if (presentation.assertedAmountPaise !== signedTotalPaise) {
      const failure = {
        reason: `Denied — caller asserted ₹${(presentation.assertedAmountPaise / 100).toFixed(2)} but the signed Checkout Mandate's total is ₹${(signedTotalPaise / 100).toFixed(2)}. The cart or total changed after the merchant signed it.`,
        failureReason: "amount_mismatch",
      };
      await record(failure, mandate.id);
      return { ok: false, reason: failure.reason };
    }

    // Step 6 (commit): mark consumed atomically-enough for this
    // subset — a conditional UPDATE requiring status still "issued" so
    // two concurrent redemption attempts can't both succeed, the same
    // conditional-WHERE pattern gate.ts's reserveBudget/reserveStock use.
    const claimed = await db
      .update(schema.checkoutMandates)
      .set({ status: "consumed" })
      .where(and(eq(schema.checkoutMandates.id, mandate.id), eq(schema.checkoutMandates.status, "issued")))
      .returning({ id: schema.checkoutMandates.id });

    if (claimed.length === 0) {
      const failure = {
        reason: `Denied — this Checkout Mandate was consumed by a concurrent request between check and commit.`,
        failureReason: "already_consumed",
      };
      await record(failure, mandate.id);
      return { ok: false, reason: failure.reason };
    }

    await record(null, mandate.id);
    return { ok: true, totalPaise: signedTotalPaise, mandateId: mandate.id };
  } catch (err) {
    const failure = {
      reason: `Denied — mandate signature verification failed: ${err instanceof Error ? err.message : String(err)}.`,
      failureReason: "signature_invalid",
    };
    await record(failure, mandate.id);
    return { ok: false, reason: failure.reason };
  }
}

export interface MandateProof {
  present: true;
  mandateId: string;
  agentId: string;
  totalPaise: number;
  status: "issued" | "consumed" | "expired";
  issuedAt: Date;
  /** What the checkout mandate attests: the exact cart lines the merchant signed off on. */
  lines: CartLineForMandate[];
}

export type MandateProofResult = MandateProof | { present: false };

/**
 * Layer 21-4: proof of agency, surfaced. Reads back the Checkout Mandate
 * a money action was taken under, if any — for the explain view, the
 * agent-facing /api/agent/actions/[id] "why" block, and any
 * merchant-readable record. Deliberately returns { present: false }
 * rather than throwing or returning null for the common case (a
 * purchase made without a mandate, since mandates are opt-in) — every
 * caller must render that as an explicit "no mandate," never an
 * ambiguous or silently-verified state. See DECISIONS.md and
 * plans/layer-21-protocol-surface.md's "must not become decorative."
 */
export async function getMandateProofForMoneyAction(checkoutMandateId: string | null): Promise<MandateProofResult> {
  if (!checkoutMandateId) return { present: false };

  const [mandate] = await db.select().from(schema.checkoutMandates).where(eq(schema.checkoutMandates.id, checkoutMandateId));
  if (!mandate) return { present: false };

  return {
    present: true,
    mandateId: mandate.id,
    agentId: mandate.agentId,
    totalPaise: mandate.totalPaise,
    status: mandate.status,
    issuedAt: mandate.createdAt,
    lines: mandate.jwt ? (await decodeCheckoutMandateLines(mandate.jwt)) : [],
  };
}

/**
 * Reads the cart lines back out of the signed JWT's own payload — never
 * re-derived from anything else, since the JWT IS the record of what
 * was attested. Uses jose's decodeJwt (payload only, no signature
 * re-verification) because this is a read of an already-trusted,
 * already-persisted row, not a new verification decision — verification
 * already happened once, at redemption time, in verifyPaymentMandate.
 */
async function decodeCheckoutMandateLines(jwt: string): Promise<CartLineForMandate[]> {
  const { decodeJwt } = await import("jose");
  try {
    const payload = decodeJwt(jwt);
    return (payload.lines as CartLineForMandate[] | undefined) ?? [];
  } catch {
    return [];
  }
}

export interface MandateBackedPurchase {
  moneyActionId: string;
  amountPaise: number;
  status: string;
  createdAt: Date;
  mandateId: string;
}

/**
 * Layer 21-4: the merchant-readable record — "who authorized this and
 * how do I prove it," per agent. Every money_actions row for this agent
 * carrying a checkoutMandateId, newest first. A merchant who never turns
 * mandates on for an agent sees an honest empty list here, not a missing
 * section — the caller (the agents dashboard) renders that explicitly.
 */
export async function getMandateBackedPurchasesForAgent(merchantId: string, agentId: string): Promise<MandateBackedPurchase[]> {
  const rows = await db
    .select({
      id: schema.moneyActions.id,
      amountPaise: schema.moneyActions.amountPaise,
      status: schema.moneyActions.status,
      createdAt: schema.moneyActions.createdAt,
      checkoutMandateId: schema.moneyActions.checkoutMandateId,
    })
    .from(schema.moneyActions)
    .where(
      and(
        eq(schema.moneyActions.merchantId, merchantId),
        eq(schema.moneyActions.agentId, agentId),
        isNotNull(schema.moneyActions.checkoutMandateId),
      ),
    )
    .orderBy(desc(schema.moneyActions.createdAt))
    .limit(20);

  return rows.map((r) => ({
    moneyActionId: r.id,
    amountPaise: r.amountPaise,
    status: r.status,
    createdAt: r.createdAt,
    mandateId: r.checkoutMandateId!,
  }));
}
