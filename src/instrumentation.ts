import { registerOTel } from "@vercel/otel";
import { MoneyPathCaptureProcessor } from "@/lib/tracing";

/**
 * Layer 15-1: registers Next.js's own OTel instrumentation
 * (node_modules/next/dist/docs/01-app/02-guides/open-telemetry.md) plus
 * one additive processor — MoneyPathCaptureProcessor — that buffers the
 * money path's own spans in memory for the /dashboard/explain waterfall.
 * No external collector or exporter is configured: this is deliberately
 * not an observability stack, per CLAUDE.md and plans/layer-15.
 */
export function register() {
  registerOTel({
    serviceName: "thirdman",
    spanProcessors: [new MoneyPathCaptureProcessor()],
  });
}
