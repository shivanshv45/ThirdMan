import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay signs the raw request body, not a re-serialised JSON.stringify
 * of the parsed object — those differ in whitespace and key order, so the
 * HMAC only matches if computed over the exact bytes Razorpay sent. Callers
 * must pass req.text() output here, never JSON.stringify(await req.json()).
 * See FAILURES.md.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(signatureHeader, "hex");

  // timingSafeEqual throws on mismatched lengths rather than returning
  // false, and a forged header is exactly the case where lengths differ.
  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}
