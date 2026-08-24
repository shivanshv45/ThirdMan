import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyCheckoutSignature } from "@/lib/payment-verify";

const SECRET = "test-key-secret";
const ORDER_ID = "order_test123";
const PAYMENT_ID = "pay_test456";

function sign(orderId: string, paymentId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

describe("verifyCheckoutSignature", () => {
  it("verifies a correct signature", () => {
    const signature = sign(ORDER_ID, PAYMENT_ID, SECRET);
    expect(verifyCheckoutSignature(ORDER_ID, PAYMENT_ID, signature, SECRET)).toBe(true);
  });

  it("rejects a tampered order id signed under a different order", () => {
    const signature = sign(ORDER_ID, PAYMENT_ID, SECRET);
    expect(verifyCheckoutSignature("order_different", PAYMENT_ID, signature, SECRET)).toBe(false);
  });

  it("rejects a tampered payment id", () => {
    const signature = sign(ORDER_ID, PAYMENT_ID, SECRET);
    expect(verifyCheckoutSignature(ORDER_ID, "pay_different", signature, SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = sign(ORDER_ID, PAYMENT_ID, "wrong-secret");
    expect(verifyCheckoutSignature(ORDER_ID, PAYMENT_ID, signature, SECRET)).toBe(false);
  });

  it("rejects missing fields rather than throwing", () => {
    expect(() => verifyCheckoutSignature("", PAYMENT_ID, "abc", SECRET)).not.toThrow();
    expect(verifyCheckoutSignature("", PAYMENT_ID, "abc", SECRET)).toBe(false);
    expect(verifyCheckoutSignature(ORDER_ID, "", "abc", SECRET)).toBe(false);
    expect(verifyCheckoutSignature(ORDER_ID, PAYMENT_ID, "", SECRET)).toBe(false);
  });

  it("fails rather than throws on a signature of a different length", () => {
    expect(() => verifyCheckoutSignature(ORDER_ID, PAYMENT_ID, "abc", SECRET)).not.toThrow();
    expect(verifyCheckoutSignature(ORDER_ID, PAYMENT_ID, "abc", SECRET)).toBe(false);
  });
});
