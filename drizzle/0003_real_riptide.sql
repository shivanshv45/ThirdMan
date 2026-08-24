CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "razorpay_key_id_encrypted" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "razorpay_key_secret_encrypted" text;--> statement-breakpoint
-- Backfill pre-existing dev/seed data before enforcing NOT NULL below.
-- No real merchants exist yet at this point in the project (see PROGRESS.md,
-- Layer 2), so a placeholder email/hash is safe here and never reachable
-- via login since the hash format ("locked:...") never matches a real
-- scrypt-derived hash.
UPDATE "merchants" SET "email" = 'unclaimed+' || "id" || '@migration.invalid' WHERE "email" IS NULL;--> statement-breakpoint
UPDATE "merchants" SET "password_hash" = 'locked:no-login-until-password-set' WHERE "password_hash" IS NULL;--> statement-breakpoint
UPDATE "audit_log" a SET "merchant_id" = m."merchant_id"
	FROM "money_actions" m
	WHERE a."money_action_id" = m."id" AND a."merchant_id" IS NULL;--> statement-breakpoint
UPDATE "audit_log" SET "merchant_id" = (SELECT "id" FROM "merchants" ORDER BY "created_at" LIMIT 1) WHERE "merchant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "merchant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "password_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_email_unique" UNIQUE("email");
