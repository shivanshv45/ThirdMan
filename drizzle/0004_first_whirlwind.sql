CREATE TYPE "public"."payment_failure_source" AS ENUM('webhook', 'simulated');--> statement-breakpoint
CREATE TYPE "public"."payment_failure_status" AS ENUM('new', 'diagnosed', 'recovering', 'recovered', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."recovery_outcome" AS ENUM('pending', 'succeeded', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."recovery_strategy" AS ENUM('retry_same_instrument', 'alternate_instrument', 'payment_link_nudge', 'human_escalation', 'write_off');--> statement-breakpoint
CREATE TABLE "payment_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"amount_paise" integer NOT NULL,
	"decline_code" text NOT NULL,
	"decline_description" text,
	"customer_ref" text,
	"source" "payment_failure_source" NOT NULL,
	"status" "payment_failure_status" DEFAULT 'new' NOT NULL,
	"diagnosis" jsonb,
	"failed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_failure_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"strategy" "recovery_strategy" NOT NULL,
	"money_action_id" uuid,
	"outcome" "recovery_outcome" DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"recovered_paise" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "payment_failures" ADD CONSTRAINT "payment_failures_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_payment_failure_id_payment_failures_id_fk" FOREIGN KEY ("payment_failure_id") REFERENCES "public"."payment_failures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_money_action_id_money_actions_id_fk" FOREIGN KEY ("money_action_id") REFERENCES "public"."money_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_failures_merchant_payment_idx" ON "payment_failures" USING btree ("merchant_id","razorpay_payment_id") WHERE "payment_failures"."razorpay_payment_id" is not null;