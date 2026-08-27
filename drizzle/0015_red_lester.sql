CREATE TYPE "public"."negotiation_status" AS ENUM('open', 'agreed', 'refused_floor', 'refused_turns_exhausted', 'expired', 'redeemed');--> statement-breakpoint
CREATE TYPE "public"."negotiation_turn_speaker" AS ENUM('buyer', 'merchant_agent');--> statement-breakpoint
CREATE TABLE "negotiation_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"negotiation_id" uuid NOT NULL,
	"speaker" "negotiation_turn_speaker" NOT NULL,
	"offered_unit_price_paise" integer,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "negotiations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"agent_id" uuid,
	"session_token" text,
	"status" "negotiation_status" DEFAULT 'open' NOT NULL,
	"catalogue_unit_price_paise" integer NOT NULL,
	"floor_unit_price_paise" integer NOT NULL,
	"current_buyer_offer_paise" integer,
	"current_merchant_counter_paise" integer,
	"agreed_unit_price_paise" integer,
	"buyer_turn_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "money_actions" ADD COLUMN "negotiation_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "floor_price_paise" integer;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "below_cost_floor_acknowledged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "negotiation_turns" ADD CONSTRAINT "negotiation_turns_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_actions" ADD CONSTRAINT "money_actions_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE no action ON UPDATE no action;