CREATE TABLE "login_throttle_state" (
	"email" text PRIMARY KEY NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"limit_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_windows_key_window_idx" ON "rate_limit_windows" USING btree ("limit_key","window_start");