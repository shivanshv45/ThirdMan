CREATE TABLE "instant_audit_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"report_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_shadow_mode" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_shadow_mode" ADD CONSTRAINT "merchant_shadow_mode_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;