CREATE TYPE "public"."model_use_case" AS ENUM('support_chat', 'recovery_diagnosis', 'negotiation', 'classification');--> statement-breakpoint
CREATE TYPE "public"."reward_rule_source" AS ENUM('merchant_authored', 'llm_drafted');--> statement-breakpoint
CREATE TYPE "public"."treasury_ledger_bucket" AS ENUM('buyer_credits', 'merchant_ai_budget', 'reserve');--> statement-breakpoint
CREATE TYPE "public"."treasury_ledger_reason" AS ENUM('capture_allocation', 'model_spend', 'buyer_credit_funding');--> statement-breakpoint
CREATE TABLE "model_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"use_case" "model_use_case" NOT NULL,
	"budget_paise" integer NOT NULL,
	"period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_call_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"use_case" "model_use_case" NOT NULL,
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"cost_paise" integer NOT NULL,
	"premium_cost_paise" integer NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reward_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"description" text NOT NULL,
	"ast_json" jsonb NOT NULL,
	"source" "reward_rule_source" NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"bucket" "treasury_ledger_bucket" NOT NULL,
	"amount_paise" integer NOT NULL,
	"reason" "treasury_ledger_reason" NOT NULL,
	"money_action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_settings" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"allocation_basis_points" integer NOT NULL,
	"buyer_share_bps" integer NOT NULL,
	"merchant_share_bps" integer NOT NULL,
	"reserve_share_bps" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_budgets" ADD CONSTRAINT "model_budgets_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_call_costs" ADD CONSTRAINT "model_call_costs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_ledger" ADD CONSTRAINT "treasury_ledger_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_ledger" ADD CONSTRAINT "treasury_ledger_money_action_id_money_actions_id_fk" FOREIGN KEY ("money_action_id") REFERENCES "public"."money_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_settings" ADD CONSTRAINT "treasury_settings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_budgets_merchant_use_case_idx" ON "model_budgets" USING btree ("merchant_id","use_case");