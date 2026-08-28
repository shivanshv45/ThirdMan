import { describe, it, expect } from "vitest";
import { createTestMerchant } from "@/lib/test-helpers";
import { normalizeEmail, recordContact, isContactable, unsubscribeContact, getContactByToken } from "@/lib/contacts";

describe("normalizeEmail", () => {
  it("trims and lowercases a valid address", () => {
    expect(normalizeEmail("  Test@Example.COM  ")).toBe("test@example.com");
  });

  it("rejects garbage input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("missing-domain@")).toBeNull();
    expect(normalizeEmail("@missing-local.com")).toBeNull();
    expect(normalizeEmail("no-at-sign.com")).toBeNull();
  });

  it("rejects an absurdly long address", () => {
    expect(normalizeEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
  });
});

describe("recordContact — upsert idempotency", () => {
  it("is one row with one unsubscribe token across two consent sources for the same address", async () => {
    const merchant = await createTestMerchant("contacts-upsert");

    const first = await recordContact({ merchantId: merchant.id, address: "buyer@example.com", consentSource: "checkout" });
    const second = await recordContact({ merchantId: merchant.id, address: "Buyer@Example.com", consentSource: "chat_restock_request" });

    expect(second.id).toBe(first.id);
    expect(second.unsubscribeToken).toBe(first.unsubscribeToken);
    // The FIRST consent source wins — recordContact never overwrites an
    // existing row's provenance on a later call.
    expect(second.consentSource).toBe("checkout");
  });

  it("does not resurrect an unsubscribed contact on a later call", async () => {
    const merchant = await createTestMerchant("contacts-no-resurrect");

    const contact = await recordContact({ merchantId: merchant.id, address: "leaveme@example.com", consentSource: "checkout" });
    await unsubscribeContact(contact.id);

    const again = await recordContact({ merchantId: merchant.id, address: "leaveme@example.com", consentSource: "recovery_intake" });

    expect(again.id).toBe(contact.id);
    expect(isContactable(again)).toBe(false);
    expect(again.unsubscribedAt).not.toBeNull();
  });
});

describe("unsubscribeContact", () => {
  it("stops a real subsequent isContactable check, and is idempotent", async () => {
    const merchant = await createTestMerchant("contacts-unsub");
    const contact = await recordContact({ merchantId: merchant.id, address: "unsub-me@example.com", consentSource: "checkout" });

    expect(isContactable(contact)).toBe(true);

    const first = await unsubscribeContact(contact.id);
    expect(first).not.toBeNull();
    expect(isContactable(first!)).toBe(false);

    // A second click is a no-op, not an error.
    const second = await unsubscribeContact(contact.id);
    expect(second!.unsubscribedAt?.getTime()).toBe(first!.unsubscribedAt?.getTime());
  });

  it("returns null for an unknown contact id rather than throwing", async () => {
    const result = await unsubscribeContact("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

describe("getContactByToken", () => {
  it("resolves the real contact for its own token", async () => {
    const merchant = await createTestMerchant("contacts-token");
    const contact = await recordContact({ merchantId: merchant.id, address: "tokentest@example.com", consentSource: "checkout" });

    const found = await getContactByToken(contact.unsubscribeToken);
    expect(found?.id).toBe(contact.id);
  });

  it("returns null for an unknown token", async () => {
    const found = await getContactByToken("not-a-real-token");
    expect(found).toBeNull();
  });
});

describe("cross-merchant isolation", () => {
  it("the same email address for two different merchants produces two independent contact rows", async () => {
    const merchantA = await createTestMerchant("contacts-iso-a");
    const merchantB = await createTestMerchant("contacts-iso-b");

    const contactA = await recordContact({ merchantId: merchantA.id, address: "shared@example.com", consentSource: "checkout" });
    const contactB = await recordContact({ merchantId: merchantB.id, address: "shared@example.com", consentSource: "checkout" });

    expect(contactA.id).not.toBe(contactB.id);
    expect(contactA.unsubscribeToken).not.toBe(contactB.unsubscribeToken);

    // Unsubscribing from merchant A must not silence merchant B.
    await unsubscribeContact(contactA.id);
    const bAfter = await getContactByToken(contactB.unsubscribeToken);
    expect(isContactable(bAfter!)).toBe(true);
  });
});
