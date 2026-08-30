CREATE TABLE "cli_link_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cli_link_tokens" ADD CONSTRAINT "cli_link_tokens_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;