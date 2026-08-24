import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "@/lib/webhook-verify";

const SECRET = "test-webhook-secret";
const RAW_BODY = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_test123" } } } });

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("verifies a correct signature over the exact raw body", () => {
    const signature = sign(RAW_BODY, SECRET);
    expect(verifyWebhookSignature(RAW_BODY, signature, SECRET)).toBe(true);
  });

  it("rejects a tampered body signed with the original signature", () => {
    const signature = sign(RAW_BODY, SECRET);
    const tampered = RAW_BODY.replace("payment.failed", "payment.captured");
    expect(verifyWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = sign(RAW_BODY, "wrong-secret");
    expect(verifyWebhookSignature(RAW_BODY, signature, SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature(RAW_BODY, null, SECRET)).toBe(false);
  });

  it("fails rather than throws on a signature of a different length", () => {
    expect(() => verifyWebhookSignature(RAW_BODY, "abc", SECRET)).not.toThrow();
    expect(verifyWebhookSignature(RAW_BODY, "abc", SECRET)).toBe(false);
  });

  it("confirms the signature is over the raw string, not a re-serialised JSON.stringify", () => {
    // Same object, re-serialised with different key order — this is the
    // exact bug FAILURES.md documents: computing the HMAC over
    // JSON.stringify(await req.json()) instead of the raw request text.
    const reordered = JSON.stringify({ payload: { payment: { entity: { id: "pay_test123" } } }, event: "payment.failed" });
    expect(reordered).not.toBe(RAW_BODY);

    const signature = sign(RAW_BODY, SECRET);
    expect(verifyWebhookSignature(reordered, signature, SECRET)).toBe(false);
  });
});
