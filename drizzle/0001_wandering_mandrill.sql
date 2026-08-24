CREATE TYPE "public"."escalation_outcome" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."money_action_status" ADD VALUE 'pending_escalation';--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"money_action_id" uuid NOT NULL,
	"spend_cap_id" uuid NOT NULL,
	"risk_reason" text NOT NULL,
	"outcome" "escalation_outcome" DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_money_action_id_money_actions_id_fk" FOREIGN KEY ("money_action_id") REFERENCES "public"."money_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_spend_cap_id_spend_caps_id_fk" FOREIGN KEY ("spend_cap_id") REFERENCES "public"."spend_caps"("id") ON DELETE no action ON UPDATE no action;