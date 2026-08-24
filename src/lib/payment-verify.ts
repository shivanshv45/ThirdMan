import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the signature Razorpay Checkout hands back to the browser on
 * a successful payment: HMAC-SHA256("<order_id>|<payment_id>", key_secret).
 * A client-reported success is a hint, not proof — this is the proof.
 * Same discipline as webhook-verify.ts (timingSafeEqual, never string ===),
 * kept in its own file since the inputs differ: this is signed over two
 * plain fields, not an arbitrary raw request body.
 */
export function verifyCheckoutSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string,
  keySecret: string,
): boolean {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) return false;

  const expected = createHmac("sha256", keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(razorpaySignature, "hex");

  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}
