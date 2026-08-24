import { createOrder, fetchOrder } from "@/lib/razorpay";
import { env } from "@/lib/env";

async function main() {
  const credentials = { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET };

  const order = await createOrder(credentials, {
    amountPaise: 49900,
    receipt: `check_${Date.now()}`,
    notes: { purpose: "L0-5 verification script" },
  });

  console.log("Created order:", order);

  const fetched = await fetchOrder(credentials, order.id);
  console.log("Fetched back:", fetched);

  if (fetched.id !== order.id || fetched.amountPaise !== 49900) {
    throw new Error("Order round-trip mismatch");
  }

  console.log("Razorpay client check passed. Verify this order id appears in the Test Mode dashboard:", order.id);
}

main().catch((err) => {
  console.error("Razorpay check FAILED:", err);
  process.exit(1);
});
