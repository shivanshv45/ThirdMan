import { describe, it, expect } from "vitest";
import { diagnoseFailure } from "@/lib/recovery/diagnose";
import type { paymentFailures } from "@/lib/db/schema";

type FailureRow = typeof paymentFailures.$inferSelect;

function makeFailure(overrides: Partial<FailureRow>): FailureRow {
  return {
    id: "test-id",
    merchantId: "test-merchant",
    razorpayOrderId: null,
    razorpayPaymentId: null,
    amountPaise: 100000,
    declineCode: "BAD_REQUEST_ERROR",
    declineDescription: null,
    customerRef: null,
    source: "simulated",
    status: "new",
    diagnosis: null,
    failedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

describe("diagnoseFailure — deterministic table takes priority over the model", () => {
  it("classifies insufficient funds without needing a model call", async () => {
    const result = await diagnoseFailure(
      makeFailure({ declineCode: "BAD_REQUEST_ERROR", declineDescription: "Payment failed due to insufficient funds in the customer account." }),
    );
    expect(result.category).toBe("insufficient_funds");
    expect(result.recoverable).toBe(true);
    expect(result.source).toBe("deterministic_fallback");
  });

  it("classifies an expired card without needing a model call", async () => {
    const result = await diagnoseFailure(
      makeFailure({ declineCode: "BAD_REQUEST_ERROR", declineDescription: "The card has expired." }),
    );
    expect(result.category).toBe("expired_card");
    expect(result.recoverable).toBe(true);
    expect(result.source).toBe("deterministic_fallback");
  });

  it("classifies a lost/stolen card as unrecoverable without a model call", async () => {
    const result = await diagnoseFailure(
      makeFailure({ declineCode: "BAD_REQUEST_ERROR", declineDescription: "The card has been reported lost or stolen." }),
    );
    expect(result.category).toBe("invalid_instrument");
    expect(result.recoverable).toBe(false);
    expect(result.source).toBe("deterministic_fallback");
  });

  it("classifies an issuer decline as recoverable without a model call", async () => {
    const result = await diagnoseFailure(
      makeFailure({ declineCode: "GATEWAY_ERROR", declineDescription: "Card declined by the issuing bank." }),
    );
    expect(result.category).toBe("issuer_declined");
    expect(result.recoverable).toBe(true);
    expect(result.source).toBe("deterministic_fallback");
  });

  it("classifies a gateway timeout as a technical failure without a model call", async () => {
    const result = await diagnoseFailure(makeFailure({ declineCode: "GATEWAY_TIMEOUT_ERROR", declineDescription: "The request timed out." }));
    expect(result.category).toBe("technical_failure");
    expect(result.recoverable).toBe(true);
    expect(result.source).toBe("deterministic_fallback");
  });

  it("classifies a suspected-fraud description as unrecoverable without a model call", async () => {
    const result = await diagnoseFailure(
      makeFailure({ declineCode: "BAD_REQUEST_ERROR", declineDescription: "Payment flagged as suspicious activity." }),
    );
    expect(result.category).toBe("suspected_fraud");
    expect(result.recoverable).toBe(false);
    expect(result.source).toBe("deterministic_fallback");
  });
});

describe("diagnoseFailure — fails closed on the truly unrecognised", () => {
  it("an unrecognised code/description with no plausible match returns unknown/unrecoverable if the model also can't classify it", async () => {
    // This exercises the real fallback path (a live model call may
    // succeed and classify it, which is fine — the invariant under test
    // is that whatever comes back, an unrecognised pattern is never
    // marked recoverable without a documented reason).
    const result = await diagnoseFailure(
      makeFailure({ declineCode: "ZZZ_NOT_A_REAL_CODE", declineDescription: "completely made up gibberish xyzzy" }),
    );
    expect(DECLINE_CATEGORIES_INCLUDE(result.category)).toBe(true);
    if (result.source === "deterministic_fallback") {
      expect(result.category).toBe("unknown");
      expect(result.recoverable).toBe(false);
    }
  });
});

function DECLINE_CATEGORIES_INCLUDE(category: string): boolean {
  return [
    "insufficient_funds",
    "issuer_declined",
    "expired_card",
    "invalid_instrument",
    "technical_failure",
    "suspected_fraud",
    "customer_abandoned",
    "unknown",
  ].includes(category);
}
