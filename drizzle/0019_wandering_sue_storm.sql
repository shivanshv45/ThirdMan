CREATE TYPE "public"."contact_channel" AS ENUM('email');--> statement-breakpoint
CREATE TYPE "public"."contact_consent_source" AS ENUM('checkout', 'chat_restock_request', 'recovery_intake', 'merchant_entered');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed', 'exhausted', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."recipient_kind" AS ENUM('customer', 'merchant');--> statement-breakpoint
CREATE TYPE "public"."restock_request_status" AS ENUM('waiting', 'notified', 'cancelled');--> statement-breakpoint
CREATE TABLE "ai_credit_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"agent_id" uuid,
	"session_token" text,
	"coins_spent" integer NOT NULL,
	"reward_ledger_id" uuid NOT NULL,
	"prompt_excerpt" text NOT NULL,
	"response_excerpt" text,
	"provider_served" text,
	"succeeded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_credit_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"provider" text NOT NULL,
	"coins_per_request" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"channel" "contact_channel" DEFAULT 'email' NOT NULL,
	"address" text NOT NULL,
	"consent_source" "contact_consent_source" NOT NULL,
	"consent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_contacts_unsubscribe_token_unique" UNIQUE("unsubscribe_token")
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"contact_id" uuid,
	"recipient_kind" "recipient_kind" NOT NULL,
	"notification_type" text NOT NULL,
	"channel" "contact_channel" DEFAULT 'email' NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"provider_message_id" text,
	"money_action_id" uuid,
	"related_entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restock_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" "restock_request_status" DEFAULT 'waiting' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "escalations" SET "expires_at" = "created_at" + interval '48 hours' WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "escalations" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_failures" ADD COLUMN "customer_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_credit_redemptions" ADD CONSTRAINT "ai_credit_redemptions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_redemptions" ADD CONSTRAINT "ai_credit_redemptions_tier_id_ai_credit_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."ai_credit_tiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_redemptions" ADD CONSTRAINT "ai_credit_redemptions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_redemptions" ADD CONSTRAINT "ai_credit_redemptions_reward_ledger_id_reward_coin_ledger_id_fk" FOREIGN KEY ("reward_ledger_id") REFERENCES "public"."reward_coin_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_tiers" ADD CONSTRAINT "ai_credit_tiers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_contact_id_customer_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_money_action_id_money_actions_id_fk" FOREIGN KEY ("money_action_id") REFERENCES "public"."money_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_contact_id_customer_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contacts_merchant_channel_address_idx" ON "customer_contacts" USING btree ("merchant_id","channel","address");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_dedupe_idx" ON "notification_deliveries" USING btree ("notification_type","related_entity_id","contact_id") WHERE "notification_deliveries"."related_entity_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "restock_requests_waiting_idx" ON "restock_requests" USING btree ("variant_id","contact_id") WHERE "restock_requests"."status" = 'waiting';--> statement-breakpoint
ALTER TABLE "payment_failures" ADD CONSTRAINT "payment_failures_customer_contact_id_customer_contacts_id_fk" FOREIGN KEY ("customer_contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE no action ON UPDATE no action;