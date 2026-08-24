CREATE TYPE "public"."product_status" AS ENUM('active', 'archived');--> statement-breakpoint
ALTER TABLE "money_actions" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "money_actions" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "status" "product_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "money_actions" ADD CONSTRAINT "money_actions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;