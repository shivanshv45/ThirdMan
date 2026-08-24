import { createOrder, RazorpayCallError } from "@/lib/razorpay";

async function main() {
  try {
    // amount 0 is invalid — Razorpay should reject this with a real API error.
    await createOrder({ amountPaise: 0, receipt: `check_err_${Date.now()}` });
    throw new Error("Expected createOrder to throw for amountPaise: 0");
  } catch (err) {
    if (!(err instanceof RazorpayCallError)) {
      throw new Error(`Expected RazorpayCallError, got ${err}`);
    }
    console.log("Correctly wrapped as RazorpayCallError:");
    console.log("  isRazorpayError:", err.isRazorpayError);
    console.log("  razorpayCode:", err.razorpayCode);
    console.log("  message:", err.message);

    if (!err.isRazorpayError) {
      throw new Error("Expected isRazorpayError: true for an API-level rejection");
    }
  }

  console.log("Error wrapping check passed.");
}

main().catch((err) => {
  console.error("Error wrapping check FAILED:", err);
  process.exit(1);
});
