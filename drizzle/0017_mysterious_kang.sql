CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_purchase_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_paise" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_cart_product_id_products_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_cart_variant_id_product_variants_id_fk";
--> statement-breakpoint
ALTER TABLE "money_actions" ADD COLUMN "cart_id" uuid;--> statement-breakpoint
-- Backfill: carry any existing single-line cart state into the new
-- cart_items table before the old columns are dropped below, so an
-- in-progress chat cart isn't silently lost by this migration.
INSERT INTO "cart_items" ("conversation_id", "variant_id", "quantity")
SELECT "id", "cart_variant_id", "cart_quantity" FROM "conversations" WHERE "cart_variant_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_purchase_items" ADD CONSTRAINT "cart_purchase_items_cart_purchase_id_cart_purchases_id_fk" FOREIGN KEY ("cart_purchase_id") REFERENCES "public"."cart_purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_purchase_items" ADD CONSTRAINT "cart_purchase_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_purchases" ADD CONSTRAINT "cart_purchases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_purchases" ADD CONSTRAINT "cart_purchases_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_conversation_variant_idx" ON "cart_items" USING btree ("conversation_id","variant_id");--> statement-breakpoint
ALTER TABLE "money_actions" ADD CONSTRAINT "money_actions_cart_id_cart_purchases_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."cart_purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "cart_product_id";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "cart_variant_id";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "cart_quantity";