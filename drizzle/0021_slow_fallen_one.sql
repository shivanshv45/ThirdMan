CREATE TABLE "merchant_alert_settings" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"escalation_pending_enabled" boolean DEFAULT true NOT NULL,
	"hold_expiring_enabled" boolean DEFAULT true NOT NULL,
	"notification_exhausted_enabled" boolean DEFAULT true NOT NULL,
	"webhook_exhausted_enabled" boolean DEFAULT true NOT NULL,
	"last_digest_sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_alert_settings" ADD CONSTRAINT "merchant_alert_settings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;