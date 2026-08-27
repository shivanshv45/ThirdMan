"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import * as mutations from "@/lib/dashboard-mutations";
import { requireSessionMerchant } from "@/lib/auth";
import { getNegotiationTranscript } from "@/lib/negotiation";

/**
 * Thin Server Action wrapper, same pattern as
 * app/dashboard/products/actions.ts — resolve the session merchant,
 * parse FormData, delegate to dashboard-mutations.ts, then revalidate.
 */

export async function setNegotiationFloor(formData: FormData) {
  const merchant = await requireSessionMerchant();

  const rawFloor = String(formData.get("floorPriceRupees") ?? "").trim();
  const floorPriceRupees = rawFloor === "" ? null : Number(rawFloor);

  try {
    await mutations.setVariantNegotiationFloor({
      merchantId: merchant.id,
      variantId: String(formData.get("variantId")),
      floorPriceRupees,
      belowCostAcknowledged: formData.get("belowCostAcknowledged") === "on",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not set negotiation floor.";
    redirect(`/dashboard/negotiations?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/negotiations");
}

export interface TranscriptTurn {
  speaker: "buyer" | "merchant_agent";
  offeredUnitPricePaise: number | null;
  message: string;
  createdAt: Date;
}

/**
 * Loads one negotiation's full transcript, re-verifying it belongs to
 * the calling merchant here rather than trusting the id alone — same
 * discipline getDecisionForMoneyAction uses for agent-scoped reads.
 */
export async function getTranscript(negotiationId: string): Promise<TranscriptTurn[]> {
  const merchant = await requireSessionMerchant();

  const [negotiation] = await db
    .select({ merchantId: schema.negotiations.merchantId })
    .from(schema.negotiations)
    .where(eq(schema.negotiations.id, negotiationId));
  if (!negotiation || negotiation.merchantId !== merchant.id) return [];

  const turns = await getNegotiationTranscript(negotiationId);
  return turns.map((t) => ({
    speaker: t.speaker,
    offeredUnitPricePaise: t.offeredUnitPricePaise,
    message: t.message,
    createdAt: t.createdAt,
  }));
}
