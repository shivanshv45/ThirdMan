CREATE TYPE "public"."agent_capability" AS ENUM('products:read', 'policy:read', 'offers:read', 'rewards:read', 'rewards:redeem', 'negotiation:create', 'purchase:create');--> statement-breakpoint
CREATE TYPE "public"."checkout_mandate_status" AS ENUM('issued', 'consumed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."guardian_state" AS ENUM('normal', 'throttled', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."mandate_verification_outcome" AS ENUM('verified', 'failed');--> statement-breakpoint
CREATE TABLE "agent_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"capability" "agent_capability" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_guardian_state" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"state" "guardian_state" DEFAULT 'normal' NOT NULL,
	"last_signal" text,
	"last_observed_value" text,
	"last_baseline_value" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkout_mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"jwt" text NOT NULL,
	"checkout_hash" text NOT NULL,
	"total_paise" integer NOT NULL,
	"status" "checkout_mandate_status" DEFAULT 'issued' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardian_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"from_state" "guardian_state" NOT NULL,
	"to_state" "guardian_state" NOT NULL,
	"trigger_signal" text NOT NULL,
	"observed_value" text NOT NULL,
	"baseline_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandate_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"checkout_mandate_id" uuid,
	"outcome" "mandate_verification_outcome" NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "mandate_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "mandate_signing_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "mandate_public_key" text;--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_guardian_state" ADD CONSTRAINT "agent_guardian_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_mandates" ADD CONSTRAINT "checkout_mandates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_mandates" ADD CONSTRAINT "checkout_mandates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_transitions" ADD CONSTRAINT "guardian_transitions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_verifications" ADD CONSTRAINT "mandate_verifications_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_verifications" ADD CONSTRAINT "mandate_verifications_checkout_mandate_id_checkout_mandates_id_fk" FOREIGN KEY ("checkout_mandate_id") REFERENCES "public"."checkout_mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_capabilities_agent_capability_idx" ON "agent_capabilities" USING btree ("agent_id","capability");--> statement-breakpoint
-- Layer 13-2: backfill every existing agent with the full capability set
-- matching what they could already do before this migration — an agent
-- that could read the catalogue and buy yesterday must still be able to
-- today. New agents created after this migration start with none granted
-- (deny by default) and a merchant explicitly checks boxes on
-- /dashboard/agents.
INSERT INTO "agent_capabilities" ("agent_id", "capability")
SELECT "id", unnest(enum_range(NULL::"public"."agent_capability"))
FROM "agents"
ON CONFLICT DO NOTHING;