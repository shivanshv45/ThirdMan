import Razorpay from "razorpay";
import { env } from "@/lib/env";

const CALL_TIMEOUT_MS = 10_000;

const client = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID,
  key_secret: env.RAZORPAY_KEY_SECRET,
});

/**
 * Distinguishes a Razorpay-side decline/rejection from a network or
 * timeout failure. Layer 2's decline diagnosis step depends on telling
 * these apart, since a card decline and a dropped connection require
 * completely different recovery actions.
 */
export class RazorpayCallError extends Error {
  /** True when Razorpay itself responded with an error (e.g. a decline). False for network/timeout failures. */
  readonly isRazorpayError: boolean;
  /** Razorpay's error code, e.g. "BAD_REQUEST_ERROR". Undefined for network/timeout failures. */
  readonly razorpayCode?: string;

  constructor(message: string, opts: { isRazorpayError: boolean; razorpayCode?: string; cause?: unknown }) {
    super(message);
    this.name = "RazorpayCallError";
    this.isRazorpayError = opts.isRazorpayError;
    this.razorpayCode = opts.razorpayCode;
    this.cause = opts.cause;
  }
}

interface RazorpayApiError {
  statusCode: string | number;
  error: { code: string; description: string };
}

function isRazorpayApiError(err: unknown): err is RazorpayApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    "error" in err &&
    typeof (err as RazorpayApiError).error?.code === "string"
  );
}

async function withTimeoutAndErrorWrapping<T>(
  operation: string,
  call: () => Promise<T>,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new RazorpayCallError(`Razorpay call "${operation}" timed out after ${CALL_TIMEOUT_MS}ms`, { isRazorpayError: false })),
      CALL_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([call(), timeout]);
  } catch (err) {
    if (err instanceof RazorpayCallError) throw err;

    if (isRazorpayApiError(err)) {
      throw new RazorpayCallError(
        `Razorpay rejected "${operation}": ${err.error.description}`,
        { isRazorpayError: true, razorpayCode: err.error.code, cause: err },
      );
    }

    throw new RazorpayCallError(
      `Razorpay call "${operation}" failed: ${err instanceof Error ? err.message : String(err)}`,
      { isRazorpayError: false, cause: err },
    );
  }
}

export interface CreateOrderInput {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrderResult {
  id: string;
  amountPaise: number;
  status: "created" | "attempted" | "paid";
  receipt: string | null | undefined;
}

/** Amounts in and out are integer paise, matching Razorpay's own convention. */
export async function createOrder(input: CreateOrderInput): Promise<RazorpayOrderResult> {
  const order = await withTimeoutAndErrorWrapping("orders.create", () =>
    client.orders.create({
      amount: input.amountPaise,
      currency: "INR",
      receipt: input.receipt,
      notes: input.notes,
    }),
  );

  return {
    id: order.id,
    amountPaise: Number(order.amount),
    status: order.status,
    receipt: order.receipt,
  };
}

export async function fetchOrder(orderId: string): Promise<RazorpayOrderResult> {
  const order = await withTimeoutAndErrorWrapping("orders.fetch", () =>
    client.orders.fetch(orderId),
  );

  return {
    id: order.id,
    amountPaise: Number(order.amount),
    status: order.status,
    receipt: order.receipt,
  };
}

export interface RazorpayPaymentResult {
  id: string;
  orderId: string | null | undefined;
  amountPaise: number;
  status: string;
  method: string;
  errorCode?: string | null;
  errorDescription?: string | null;
}

export async function fetchPayment(paymentId: string): Promise<RazorpayPaymentResult> {
  const payment = await withTimeoutAndErrorWrapping("payments.fetch", () =>
    client.payments.fetch(paymentId),
  );

  return {
    id: payment.id,
    orderId: payment.order_id,
    amountPaise: Number(payment.amount),
    status: payment.status,
    method: payment.method,
    errorCode: payment.error_code,
    errorDescription: payment.error_description,
  };
}
