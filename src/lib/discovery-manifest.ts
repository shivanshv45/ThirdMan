import { db, schema } from "@/lib/db";
import { getMerchantStorefrontInfo, getPublicCatalogue } from "@/lib/storefront-catalogue";
import { getMerchantPolicy } from "@/lib/dashboard";
import { describeMerchantPolicy } from "@/lib/policy-text";
import { getOrCreateMandateKeypair } from "@/lib/mandates";
import { getMerchantAgentTerms } from "@/lib/agent-terms";
import { env } from "@/lib/env";
import { eq } from "drizzle-orm";

/**
 * Layer 21-1/21-2: the shared body-builder behind both discovery
 * surfaces — the per-merchant /store/[merchantId]/manifest.json (Layer
 * 5-5, unchanged URL) and the new origin-root /.well-known/agent-
 * commerce.json (this layer). One function so the two documents can
 * never drift apart on what "this merchant's capabilities" means.
 *
 * The wording standard from plans/layer-21-protocol-surface.md applies
 * everywhere in this file: name the documented SUBSET implemented, never
 * a bare protocol name that implies conformance. AP2 and x402 are named
 * with their subset; ACP and NPCI UAP are named only as NOT implemented.
 */

export async function buildMerchantManifest(merchantId: string, origin: string) {
  const merchant = await getMerchantStorefrontInfo(merchantId);
  if (!merchant) return null;

  const [catalogue, policy, terms, { publicKeySpki }] = await Promise.all([
    getPublicCatalogue(merchantId),
    getMerchantPolicy(merchantId),
    getMerchantAgentTerms(merchantId),
    getOrCreateMandateKeypair(merchantId),
  ]);

  return {
    schemaVersion: "1.1",
    merchant: {
      id: merchant.id,
      name: merchant.name,
      storefrontUrl: `${origin}/store/${merchant.id}`,
      acceptingPayments: merchant.razorpayConnected,
    },
    catalogueSummary: {
      productCount: catalogue.length,
      variantCount: catalogue.reduce((sum, p) => sum + p.variants.length, 0),
      categories: [...new Set(catalogue.map((p) => p.category))],
      priceRangePaise:
        catalogue.length > 0
          ? {
              min: Math.min(...catalogue.flatMap((p) => p.variants.map((v) => v.pricePaise))),
              max: Math.max(...catalogue.flatMap((p) => p.variants.map((v) => v.pricePaise))),
            }
          : null,
    },
    policy: {
      published: policy !== null,
      summary: describeMerchantPolicy(policy),
    },
    paymentRails: {
      currency: "INR",
      processor: "razorpay",
      mode: env.NODE_ENV === "production" ? "live" : "test",
      note: "This merchant transacts in INR via Razorpay only. A purchase asserting any other currency is not supported and will be denied.",
    },
    agentAccess: {
      mcp: {
        endpoint: `${origin}/api/mcp`,
        transport: "streamable-http",
        authentication: "bearer",
        authenticationNote: "Tools are discoverable via the standard MCP handshake once authenticated — not duplicated here, since a copy would drift from the server's own tool list.",
      },
      restApiBase: `${origin}/api/agent`,
      howToObtainAccess: terms?.selfRegistrationOpen
        ? {
            method: "self_register",
            endpoint: `${origin}/api/agent/register`,
            note: "This merchant accepts self-registration. A provisional agent key is issued immediately with a merchant-set starting cap and capability set; the merchant reviews and raises limits from real transaction history.",
          }
        : {
            method: "merchant_issued",
            note: "This merchant issues agent API keys by hand from their own dashboard. There is no self-service signup — contact the merchant to obtain a key.",
          },
    },
    agentTerms: terms
      ? {
          published: true,
          unknownAgentsAllowed: terms.unknownAgentsAllowed,
          newAgentOrderCeilingPaise: terms.newAgentOrderCeilingPaise,
          mandateRequiredAbovePaise: terms.mandateRequiredAbovePaise,
          negotiationOpenToAgents: terms.negotiationOpenToAgents,
          selfRegistrationOpen: terms.selfRegistrationOpen,
        }
      : {
          published: false,
          note: "This merchant has not published agent terms. Absence is not a permissive default — treat unknown-agent transacting as closed and self-registration as unavailable.",
        },
    capabilityModel: {
      note: "The closed set of grantable capabilities. An agent holds only what the merchant explicitly granted (or, for a self-registered agent, the merchant's own configured default set) — authentication alone grants nothing.",
      grantable: schema.agentCapabilityEnum.enumValues,
      neverGrantable: {
        refunds: true,
        payouts: true,
        note: "Refunds and payouts are absent from the capability enum entirely — no capability grant, by any merchant, to any agent, could ever expose them. This is a fact about a database enum, not a policy that could be relaxed by configuration.",
      },
    },
    protocolSupport: {
      ap2: {
        implemented: true,
        subset: "A documented SUBSET of AP2 — Checkout Mandate and Payment Mandate verification as ES256-signed JWTs (ECDSA over P-256), verified before any bound is checked. Does NOT implement the full W3C Verifiable Credential or SD-JWT stack, and carries no selective disclosure.",
        publicKey: { format: "spki-pem", algorithm: "ES256", value: publicKeySpki },
        note: "Verify a Checkout or Payment Mandate this merchant signed against this key. Never publish anything from this merchant's private key material — this is the public half only.",
      },
      x402: {
        implemented: true,
        subset: "An unauthenticated purchase attempt against POST /api/agent/purchase receives HTTP 402 Payment Required with a challenge body naming the authentication scheme and where to obtain a key — not a full x402 payment-settlement flow.",
      },
      acp: { implemented: false },
      npciUap: { implemented: false, note: "NPCI's Unified Agentic Protocol is not implemented and not claimed. Named here only so an integrating agent can see it was considered and deliberately left out." },
    },
    note: env.NODE_ENV === "production" ? undefined : "Development build — pricing and availability shown are from real, non-production seed/test data.",
  };
}

/**
 * The root .well-known directory (L21-1): a list of merchants this
 * origin actually serves, each pointing at its real per-merchant
 * manifest. Chosen over a "default merchant" resolution because this
 * deployment is genuinely multi-tenant on one origin — a directory is
 * truthful about that; picking one merchant as "the" default would not
 * be. See DECISIONS.md.
 */
export async function listMerchantsForDirectory(origin: string) {
  const rows = await db
    .select({ id: schema.merchants.id, name: schema.merchants.name, connected: schema.merchants.razorpayKeyIdEncrypted })
    .from(schema.merchants);

  return rows
    .filter((r) => r.connected !== null)
    .map((r) => ({
      id: r.id,
      name: r.name,
      manifestUrl: `${origin}/store/${r.id}/manifest.json`,
      storefrontUrl: `${origin}/store/${r.id}`,
    }));
}

export async function merchantExists(merchantId: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.merchants.id }).from(schema.merchants).where(eq(schema.merchants.id, merchantId));
  return row !== undefined;
}
