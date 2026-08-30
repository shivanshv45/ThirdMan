import { requireSessionMerchant } from "@/lib/auth";
import { PageHeader, Surface } from "@/components/ui";
import { GenerateCliLinkToken } from "./link-token";

/**
 * Layer 20-6: where a merchant starts `npx thirdman init` from — a
 * one-time, 10-minute link token, never a password, is the only thing
 * that crosses from browser to terminal. See plans/layer-20-merchant-cli.md.
 */
export default async function CliPage() {
  await requireSessionMerchant();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Codebase auditor (CLI)"
        description="Run npx thirdman init in your own store's repo. It reads your real product data and pages, tells you what an AI buyer can and can't do with your store today, and offers to write the integration as a diff you approve — nothing is written without your confirmation."
      />

      <Surface variant="raised" className="p-5 space-y-4">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink">1. Run it</h2>
        <pre className="font-mono text-xs bg-ink border border-ink-line rounded-[var(--radius)] px-3 py-2.5 overflow-x-auto text-on-ink">
          npx thirdman init
        </pre>
        <p className="text-sm text-on-ink-dim">
          It works fully offline for the audit. Link an account only when it asks and you want it to create an agent key and add your site to the allowlist automatically.
        </p>
      </Surface>

      <Surface variant="raised" className="p-5 space-y-4">
        <h2 className="text-[var(--t-h4)] font-medium text-on-ink">2. Link this account (optional)</h2>
        <p className="text-sm text-on-ink-dim">
          Generates a one-time token, valid for 10 minutes. The CLI never sees your password — this token grants it exactly one thing: create one agent key with read + purchase capability, and offer to allowlist the origin it detected.
        </p>
        <GenerateCliLinkToken />
      </Surface>
    </div>
  );
}
