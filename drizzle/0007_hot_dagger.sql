CREATE TYPE "public"."escrow_hold_outcome" AS ENUM('held', 'captured', 'refunded', 'expired_refunded');--> statement-breakpoint
ALTER TYPE "public"."money_action_status" ADD VALUE 'held' BEFORE 'captured';--> statement-breakpoint
CREATE TABLE "escrow_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"money_action_id" uuid NOT NULL,
	"outcome" "escrow_hold_outcome" DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "money_actions" ADD COLUMN "hold_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "money_actions" ADD COLUMN "razorpay_payment_id" text;--> statement-breakpoint
ALTER TABLE "escrow_holds" ADD CONSTRAINT "escrow_holds_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_holds" ADD CONSTRAINT "escrow_holds_money_action_id_money_actions_id_fk" FOREIGN KEY ("money_action_id") REFERENCES "public"."money_actions"("id") ON DELETE no action ON UPDATE no action;