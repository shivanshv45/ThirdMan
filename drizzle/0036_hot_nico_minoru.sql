CREATE TABLE "agent_freeze_snapshots" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"prior_state" "guardian_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_share_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"audit_log_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_freezes" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_freeze_snapshots" ADD CONSTRAINT "agent_freeze_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_freeze_snapshots" ADD CONSTRAINT "agent_freeze_snapshots_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_share_tokens" ADD CONSTRAINT "decision_share_tokens_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_share_tokens" ADD CONSTRAINT "decision_share_tokens_audit_log_id_audit_log_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_freezes" ADD CONSTRAINT "merchant_freezes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;