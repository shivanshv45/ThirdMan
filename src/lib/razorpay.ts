import Razorpay from "razorpay";

const CALL_TIMEOUT_MS = 10_000;

/** A merchant's own Razorpay test-mode credentials, decrypted. Every call
 * builds its own client rather than sharing one, since each merchant has
 * a different key pair — see Layer 2-2 in plans/layer-2-merchant-onboarding.md. */
export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

function makeClient(credentials: RazorpayCredentials): Razorpay {
  return new Razorpay({ key_id: credentials.keyId, key_secret: credentials.keySecret });
}

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
  /**
   * true (default): Razorpay auto-captures the payment the instant
   * checkout succeeds — the normal buy-now path. false: the payment is
   * only authorised, held until a later capturePayment() call — the
   * escrow hold-and-capture flow (Layer 4-5). Passed through explicitly
   * rather than left to the merchant's account-level default, so this
   * codebase's behaviour doesn't silently change if that setting is
   * ever edited in the Razorpay dashboard.
   */
  autoCapture?: boolean;
}

export interface RazorpayOrderResult {
  id: string;
  amountPaise: number;
  status: "created" | "attempted" | "paid";
  receipt: string | null | undefined;
}

/** Amounts in and out are integer paise, matching Razorpay's own convention. */
export async function createOrder(
  credentials: RazorpayCredentials,
  input: CreateOrderInput,
): Promise<RazorpayOrderResult> {
  const client = makeClient(credentials);
  const order = await withTimeoutAndErrorWrapping("orders.create", () =>
    client.orders.create({
      amount: input.amountPaise,
      currency: "INR",
      receipt: input.receipt,
      notes: input.notes,
      payment_capture: input.autoCapture ?? true,
    }),
  );

  return {
    id: order.id,
    amountPaise: Number(order.amount),
    status: order.status,
    receipt: order.receipt,
  };
}

export async function fetchOrder(
  credentials: RazorpayCredentials,
  orderId: string,
): Promise<RazorpayOrderResult> {
  const client = makeClient(credentials);
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

export async function fetchPayment(
  credentials: RazorpayCredentials,
  paymentId: string,
): Promise<RazorpayPaymentResult> {
  const client = makeClient(credentials);
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

/**
 * Confirms a key pair actually works before it's saved as a merchant's
 * credentials — a cheap authenticated read, not orders.create, so
 * validating a merchant's account doesn't litter it with junk orders.
 * Throws RazorpayCallError on invalid credentials, same as every other
 * call here, so callers can surface Razorpay's own rejection message.
 */
export async function validateCredentials(credentials: RazorpayCredentials): Promise<void> {
  const client = makeClient(credentials);
  await withTimeoutAndErrorWrapping("orders.all (credential check)", () =>
    client.orders.all({ count: 1 }),
  );
}

/**
 * Captures a payment that was authorised but not auto-captured — the
 * escrow hold-and-capture flow (Layer 4-5). A no-op if Razorpay has
 * already auto-captured the payment. Every caller must reach this only
 * through the gate (attemptMoneyAction / an equivalent gated path), same
 * as createOrder — a capture moves value out of hold, it is a money
 * action like any other. Amounts in and out are integer paise.
 */
export async function capturePayment(
  credentials: RazorpayCredentials,
  paymentId: string,
  amountPaise: number,
): Promise<RazorpayPaymentResult> {
  const client = makeClient(credentials);
  const payment = await withTimeoutAndErrorWrapping("payments.capture", () =>
    client.payments.capture(paymentId, amountPaise, "INR"),
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

export interface RazorpayRefundResult {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: string;
}

/**
 * Refunds a captured payment, in full or in part. amountPaise omitted
 * means a full refund. Every caller must reach this only through the
 * gate, same as createOrder/capturePayment — a refund moves value out of
 * the merchant's account and needs the same audit trail as any other
 * money action.
 */
export async function refundPayment(
  credentials: RazorpayCredentials,
  paymentId: string,
  amountPaise?: number,
): Promise<RazorpayRefundResult> {
  const client = makeClient(credentials);
  const refund = await withTimeoutAndErrorWrapping("payments.refund", () =>
    client.payments.refund(paymentId, amountPaise !== undefined ? { amount: amountPaise } : {}),
  );

  return {
    id: refund.id,
    paymentId: refund.payment_id,
    amountPaise: Number(refund.amount),
    status: refund.status,
  };
}

export interface CreatePaymentLinkInput {
  amountPaise: number;
  description: string;
  referenceId: string;
}

export interface RazorpayPaymentLinkResult {
  id: string;
  shortUrl: string;
  status: string;
}

/**
 * A real, payable Razorpay Payment Link — the recovery pipeline's
 * retry_same_instrument/alternate_instrument/payment_link_nudge
 * strategies (Layer 4-3). The link itself genuinely exists and can be
 * paid; delivering it to a customer (email/SMS) is a separate, still-
 * unwired concern — notify is explicitly false here and the customer
 * object is a non-identifying placeholder, since payment_failures
 * deliberately stores no customer PII (CLAUDE.md rule 1: never log
 * secrets or full PII) and Razorpay's API requires the field to exist.
 * Never conflate "a link was generated" with "a customer was notified" —
 * see plans/layer-4-front-door.md's warning against unlabelled fiction.
 */
export async function createPaymentLink(
  credentials: RazorpayCredentials,
  input: CreatePaymentLinkInput,
): Promise<RazorpayPaymentLinkResult> {
  const client = makeClient(credentials);
  const link = await withTimeoutAndErrorWrapping("paymentLink.create", () =>
    client.paymentLink.create({
      amount: input.amountPaise,
      currency: "INR",
      description: input.description,
      reference_id: input.referenceId,
      customer: { name: "Customer", email: "customer@example.invalid", contact: "+910000000000" },
      notify: { email: false, sms: false },
    }),
  );

  return { id: link.id, shortUrl: link.short_url, status: link.status };
}

export async function fetchPaymentLink(
  credentials: RazorpayCredentials,
  paymentLinkId: string,
): Promise<RazorpayPaymentLinkResult> {
  const client = makeClient(credentials);
  const link = await withTimeoutAndErrorWrapping("paymentLink.fetch", () =>
    client.paymentLink.fetch(paymentLinkId),
  );

  return { id: link.id, shortUrl: link.short_url, status: link.status };
}
