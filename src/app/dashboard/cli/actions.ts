"use server";

import { requireSessionMerchant } from "@/lib/auth";
import { createCliLinkToken } from "@/lib/cli-link";

export type CliLinkActionState =
  | { token: string; expiresAt: string; error?: undefined }
  | { token?: undefined; expiresAt?: undefined; error: string }
  | null;

export async function generateCliLinkTokenAction(
  _prev: CliLinkActionState,
  _formData: FormData,
): Promise<CliLinkActionState> {
  const merchant = await requireSessionMerchant();
  try {
    const { token, expiresAt } = await createCliLinkToken(merchant.id);
    return { token, expiresAt: expiresAt.toISOString() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not generate a link token." };
  }
}
