CREATE TABLE "merchant_reward_settings" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"paise_per_coin" integer NOT NULL,
	"issue_rate_permille" integer NOT NULL,
	"max_redemption_percent" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_reward_settings" ADD CONSTRAINT "merchant_reward_settings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;