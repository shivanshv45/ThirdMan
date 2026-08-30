CREATE TYPE "public"."agent_registration_source" AS ENUM('merchant_issued', 'self_registered');--> statement-breakpoint
CREATE TABLE "merchant_agent_terms" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"unknown_agents_allowed" boolean DEFAULT false NOT NULL,
	"new_agent_order_ceiling_paise" integer,
	"mandate_required_above_paise" integer,
	"negotiation_open_to_agents" boolean DEFAULT false NOT NULL,
	"self_register_default_capabilities" "agent_capability"[] DEFAULT '{}'::agent_capability[] NOT NULL,
	"self_registration_open" boolean DEFAULT false NOT NULL,
	"self_register_starting_cap_paise" integer,
	"self_register_per_transaction_max_paise" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "registration_source" "agent_registration_source" DEFAULT 'merchant_issued' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "registered_ip" text;--> statement-breakpoint
ALTER TABLE "merchant_agent_terms" ADD CONSTRAINT "merchant_agent_terms_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;