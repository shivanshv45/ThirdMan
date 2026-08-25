CREATE TYPE "public"."catalogue_import_source" AS ENUM('csv', 'pasted_text');--> statement-breakpoint
CREATE TYPE "public"."catalogue_import_status" AS ENUM('previewed', 'imported', 'failed');--> statement-breakpoint
CREATE TYPE "public"."product_category" AS ENUM('food_beverage', 'apparel', 'electronics', 'home_goods', 'beauty_personal_care', 'health_wellness', 'books_media', 'toys_games', 'sporting_goods', 'office_supplies', 'other');--> statement-breakpoint
CREATE TYPE "public"."refund_method" AS ENUM('original_payment_method', 'store_credit', 'either');--> statement-breakpoint
CREATE TYPE "public"."variant_availability" AS ENUM('in_stock', 'out_of_stock', 'preorder', 'discontinued');--> statement-breakpoint
CREATE TABLE "catalogue_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"source" "catalogue_import_source" NOT NULL,
	"status" "catalogue_import_status" DEFAULT 'imported' NOT NULL,
	"rows_parsed" integer NOT NULL,
	"rows_imported" integer NOT NULL,
	"rows_skipped" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_policies" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"returns_accepted" boolean DEFAULT false NOT NULL,
	"return_window_days" integer,
	"refund_method" "refund_method",
	"restocking_fee_percent" integer,
	"shipping_regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"handling_time_days" integer,
	"warranty_months" integer,
	"policy_notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"price_paise" integer NOT NULL,
	"cost_paise" integer NOT NULL,
	"stock" integer NOT NULL,
	"availability" "variant_availability" DEFAULT 'in_stock' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gtin" text,
	"mpn" text,
	"image_url" text,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "price_paise" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "cost_paise" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "stock" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "money_actions" ADD COLUMN "variant_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category" "product_category" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "subcategory" text;--> statement-breakpoint
ALTER TABLE "catalogue_imports" ADD CONSTRAINT "catalogue_imports_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_merchant_sku_idx" ON "product_variants" USING btree ("merchant_id","sku");--> statement-breakpoint
ALTER TABLE "money_actions" ADD CONSTRAINT "money_actions_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill: every existing product gets exactly one default variant
-- carrying its old price/cost/stock, so nothing orphans once the legacy
-- columns are dropped in the next migration. SKU is derived from the
-- product id since no merchant has ever entered a real SKU yet.
INSERT INTO "product_variants" ("product_id", "merchant_id", "sku", "price_paise", "cost_paise", "stock", "availability", "status")
SELECT "id", "merchant_id", 'SKU-' || substr("id"::text, 1, 8), "price_paise", "cost_paise", "stock",
  (CASE WHEN "stock" > 0 THEN 'in_stock' ELSE 'out_of_stock' END)::"variant_availability",
  "status"
FROM "products";--> statement-breakpoint
-- Point every past money_actions row at the default variant of the
-- product it already references, so variant_id is populated for existing
-- rows too rather than left null only on new ones.
UPDATE "money_actions" ma
SET "variant_id" = pv."id"
FROM "product_variants" pv
WHERE pv."product_id" = ma."product_id" AND ma."product_id" IS NOT NULL;