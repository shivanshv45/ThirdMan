import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { describe, it, expect } from "vitest";
import { db, schema } from "@/lib/db";
import { createTestMerchant } from "@/lib/test-helpers";
import { resolveOrCreateMerchantForOAuth, type OAuthProfile } from "@/lib/oauth";

function fakeProfile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    providerAccountId: randomUUID(),
    email: `${randomUUID()}@test.invalid`,
    emailVerified: true,
    name: "Test Merchant",
    ...overrides,
  };
}

describe("resolveOrCreateMerchantForOAuth — new account", () => {
  it("creates a merchant with no password when nothing matches", async () => {
    const profile = fakeProfile({ name: "New OAuth Merchant" });

    const result = await resolveOrCreateMerchantForOAuth("google", profile);

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    const [merchant] = await db.select().from(schema.merchants).where(eq(schema.merchants.id, result.merchantId));
    expect(merchant.passwordHash).toBeNull();
    expect(merchant.email).toBe(profile.email);

    const [identity] = await db.select().from(schema.oauthIdentities).where(eq(schema.oauthIdentities.merchantId, result.merchantId));
    expect(identity.provider).toBe("google");
    expect(identity.providerAccountId).toBe(profile.providerAccountId);

    const [auditRow] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, result.merchantId));
    expect(auditRow.event).toBe("merchant_signed_up");
  });
});

describe("resolveOrCreateMerchantForOAuth — auto-link by verified email", () => {
  it("links to an existing password-account merchant when the OAuth email is verified and matches", async () => {
    const merchant = await createTestMerchant("oauth-link-target");
    const profile = fakeProfile({ email: merchant.email, emailVerified: true });

    const result = await resolveOrCreateMerchantForOAuth("github", profile);

    expect(result.outcome).toBe("linked");
    if (result.outcome !== "linked") throw new Error("unreachable");
    expect(result.merchantId).toBe(merchant.id);

    // Did not create a second merchant row for the same email.
    const merchantsWithEmail = await db.select().from(schema.merchants).where(eq(schema.merchants.email, merchant.email));
    expect(merchantsWithEmail).toHaveLength(1);

    const [identity] = await db.select().from(schema.oauthIdentities).where(eq(schema.oauthIdentities.merchantId, merchant.id));
    expect(identity.provider).toBe("github");

    const [auditRow] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.merchantId, merchant.id));
    expect(auditRow.event).toBe("oauth_identity_linked");
  });

  it("refuses to link on an UNVERIFIED email match — creates nothing and reuses no account", async () => {
    const merchant = await createTestMerchant("oauth-unverified-target");
    const profile = fakeProfile({ email: merchant.email, emailVerified: false });

    const result = await resolveOrCreateMerchantForOAuth("google", profile);

    // Unverified + email already taken -> the deliberate fail-closed refusal,
    // never silently attached to someone else's account.
    expect(result.outcome).toBe("email_taken");

    const identities = await db.select().from(schema.oauthIdentities).where(eq(schema.oauthIdentities.merchantId, merchant.id));
    expect(identities).toHaveLength(0);
  });
});

describe("resolveOrCreateMerchantForOAuth — repeat sign-in", () => {
  it("a second sign-in with the same provider account reuses the same merchant without re-linking", async () => {
    const profile = fakeProfile();

    const first = await resolveOrCreateMerchantForOAuth("google", profile);
    expect(first.outcome).toBe("created");

    const second = await resolveOrCreateMerchantForOAuth("google", profile);
    expect(second.outcome).toBe("signed_in");
    if (first.outcome === "email_taken" || second.outcome === "email_taken") throw new Error("unreachable");
    expect(second.merchantId).toBe(first.merchantId);

    const identities = await db.select().from(schema.oauthIdentities).where(eq(schema.oauthIdentities.providerAccountId, profile.providerAccountId));
    expect(identities).toHaveLength(1);
  });
});
