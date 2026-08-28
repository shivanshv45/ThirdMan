CREATE TYPE "public"."embed_position" AS ENUM('bottom_right', 'bottom_left');--> statement-breakpoint
CREATE TYPE "public"."embed_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'exhausted');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "embed_configs" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"publishable_key" text NOT NULL,
	"status" "embed_status" DEFAULT 'active' NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"display_name" text,
	"accent_color" text,
	"greeting" text,
	"position" "embed_position" DEFAULT 'bottom_right' NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embed_configs_publishable_key_unique" UNIQUE("publishable_key")
);
--> statement-breakpoint
CREATE TABLE "merchant_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"subscribed_events" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "webhook_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"money_action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embed_configs" ADD CONSTRAINT "embed_configs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_webhooks" ADD CONSTRAINT "merchant_webhooks_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_merchant_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."merchant_webhooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_money_action_id_money_actions_id_fk" FOREIGN KEY ("money_action_id") REFERENCES "public"."money_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_dedupe_idx" ON "webhook_deliveries" USING btree ("webhook_id","event_type","money_action_id") WHERE "webhook_deliveries"."money_action_id" is not null;