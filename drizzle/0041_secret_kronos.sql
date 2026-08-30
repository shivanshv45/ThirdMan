ALTER TYPE "public"."catalogue_import_source" ADD VALUE 'shopify';--> statement-breakpoint
CREATE TABLE "shopify_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"shop_domain" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"scope" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shopify_install_states" (
	"state" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"shop_domain" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopify_connections" ADD CONSTRAINT "shopify_connections_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_install_states" ADD CONSTRAINT "shopify_install_states_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_connections_merchant_idx" ON "shopify_connections" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_connections_shop_domain_idx" ON "shopify_connections" USING btree ("shop_domain");