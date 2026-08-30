CREATE TYPE "public"."return_recommendation" AS ENUM('approve', 'reject', 'needs_merchant_judgement');--> statement-breakpoint
CREATE TYPE "public"."return_request_status" AS ENUM('awaiting_merchant', 'declined_by_desk', 'approved', 'rejected', 'expired', 'refunded');--> statement-breakpoint
CREATE TABLE "return_request_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_request_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"money_action_id" uuid NOT NULL,
	"requester_contact_id" uuid,
	"requester_agent_id" uuid,
	"stated_reason" text NOT NULL,
	"status" "return_request_status" DEFAULT 'awaiting_merchant' NOT NULL,
	"refundable_amount_paise" integer NOT NULL,
	"approved_amount_paise" integer,
	"resolution_reason" text,
	"model_summary" text,
	"model_recommendation" "return_recommendation",
	"model_reasoning" text,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "return_request_messages" ADD CONSTRAINT "return_request_messages_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_money_action_id_money_actions_id_fk" FOREIGN KEY ("money_action_id") REFERENCES "public"."money_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_requester_contact_id_customer_contacts_id_fk" FOREIGN KEY ("requester_contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_requester_agent_id_agents_id_fk" FOREIGN KEY ("requester_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "return_requests_open_idx" ON "return_requests" USING btree ("money_action_id") WHERE "return_requests"."status" = 'awaiting_merchant';