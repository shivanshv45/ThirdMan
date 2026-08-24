ALTER TABLE "recovery_attempts" ADD COLUMN "razorpay_payment_link_id" text;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD COLUMN "payment_link_url" text;