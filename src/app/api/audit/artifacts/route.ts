import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionMerchant } from "@/lib/auth";
import { getOrCreateEmbedConfig } from "@/lib/embed";
import { getAppUrl } from "@/lib/env";
import { artifactsForReport } from "@/lib/integration-artifacts";

/**
 * L24-5: turns a set of failed check ids from the Instant Audit into
 * exact, paste-able artifacts for THIS merchant's own account — the
 * widget snippet needs a real publishable key, so this route is
 * session-gated (unlike /api/audit itself, which never discloses
 * anything merchant-specific) rather than public.
 */

const requestSchema = z.object({
  checkIds: z.array(z.string()).max(50),
});

export async function POST(req: NextRequest) {
  const merchant = await getSessionMerchant();
  if (!merchant) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "checkIds must be an array of strings." }, { status: 400 });
  }

  const embedConfig = await getOrCreateEmbedConfig(merchant.id);
  const artifacts = artifactsForReport(parsed.data.checkIds, {
    appOrigin: getAppUrl(),
    publishableKey: embedConfig.publishableKey,
  });

  return NextResponse.json({ artifacts });
}
