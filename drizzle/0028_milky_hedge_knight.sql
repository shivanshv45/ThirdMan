CREATE TYPE "public"."memory_kind" AS ENUM('derived', 'stated');--> statement-breakpoint
CREATE TYPE "public"."memory_subject_type" AS ENUM('customer_contact', 'agent');--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"subject_type" "memory_subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "customer_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memories_subject_key_idx" ON "agent_memories" USING btree ("merchant_id","subject_type","subject_id","key");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_contact_id_customer_contacts_id_fk" FOREIGN KEY ("customer_contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE no action ON UPDATE no action;