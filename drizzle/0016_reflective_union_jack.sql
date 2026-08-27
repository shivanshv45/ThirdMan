ALTER TABLE "negotiations" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "negotiations" ALTER COLUMN "status" SET DEFAULT 'open'::text;--> statement-breakpoint
DROP TYPE "public"."negotiation_status";--> statement-breakpoint
CREATE TYPE "public"."negotiation_status" AS ENUM('open', 'agreed', 'refused_turns_exhausted', 'expired', 'redeemed');--> statement-breakpoint
ALTER TABLE "negotiations" ALTER COLUMN "status" SET DEFAULT 'open'::"public"."negotiation_status";--> statement-breakpoint
ALTER TABLE "negotiations" ALTER COLUMN "status" SET DATA TYPE "public"."negotiation_status" USING "status"::"public"."negotiation_status";