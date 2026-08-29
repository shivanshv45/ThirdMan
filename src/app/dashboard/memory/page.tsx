import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getMemoryOverview, type MemoryRow } from "@/lib/dashboard";
import { confirmMemoryAction, correctMemoryAction, deleteMemoryAction } from "../actions";
import { PageHeader, Surface, Button, EmptyState, DecisionBadge, Field, Input } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function groupBySubject(rows: MemoryRow[]): Map<string, MemoryRow[]> {
  const groups = new Map<string, MemoryRow[]>();
  for (const row of rows) {
    const key = `${row.subjectType}:${row.subjectId}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/**
 * Layer 18-6: what the system remembers, about whom, from where. Every
 * row is real (agent_memories), never a sample — an empty bank renders
 * as EmptyState, not a placeholder row. A stated memory shows its
 * pending/confirmed state and a confirm action; every row carries its
 * real provenance and, where a real page exists for it, a link to the
 * source.
 */
export default async function MemoryPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const rows = await getMemoryOverview(merchant.id);
  const groups = groupBySubject(rows);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Memory Bank"
        description="Context that outlives one chat session, anchored only to real identities this product has — a customer contact, an agent. This never influences a spend cap, a price, or a gate decision; it only changes what the assistant says. A stated memory stays pending until confirmed here; it is never retrieved before that."
      />

      {groups.size === 0 ? (
        <EmptyState
          title="No memories yet"
          description="A memory is created when a returning customer's identity becomes known (they provide an email during a chat) and either code computes a real fact about them or they state one directly. Nothing has happened yet."
        />
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([subjectKey, subjectRows]) => {
            const [subjectType] = subjectKey.split(":");
            const label = subjectRows[0].subjectLabel;
            return (
              <Surface key={subjectKey} variant="raised" className="p-5">
                <div className="flex items-center gap-2.5 mb-4">
                  <span className="text-[var(--t-h4)] font-medium text-on-ink truncate">{label}</span>
                  <DecisionBadge decision="n/a" label={subjectType === "agent" ? "agent" : "customer contact"} compact />
                </div>

                <div className="space-y-3">
                  {subjectRows.map((row) => (
                    <div key={row.id} className="border-t border-ink-line-soft pt-3 first:border-t-0 first:pt-0">
                      <div className="flex items-start justify-between flex-wrap gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono text-on-ink-faint uppercase">{row.key}</span>
                            <DecisionBadge decision={row.kind === "derived" ? "allow" : row.confirmedAt ? "allow" : "escalate"} label={row.kind === "derived" ? "derived" : row.confirmedAt ? "confirmed" : "pending"} compact />
                          </div>
                          <p className="mt-1 text-sm text-on-ink">{row.value}</p>
                          <p className="mt-1 text-xs text-on-ink-faint">
                            Source: {row.sourceType}
                            {row.sourceType === "money_action" ? (
                              <>
                                {" — "}
                                <a href={`/dashboard/explain?moneyActionId=${row.sourceId}`} className="text-[var(--allow-bright)] hover:underline">
                                  view the money action →
                                </a>
                              </>
                            ) : (
                              ` (${row.sourceId.slice(0, 8)})`
                            )}
                            {" · updated "}
                            {formatDate(row.updatedAt)}
                            {row.expiresAt && ` · expires ${formatDate(row.expiresAt)}`}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {row.kind === "stated" && !row.confirmedAt && (
                            <form action={confirmMemoryAction}>
                              <input type="hidden" name="memoryId" value={row.id} />
                              <Button type="submit" variant="secondary" size="sm" pendingLabel="Confirming…">
                                Confirm
                              </Button>
                            </form>
                          )}
                          <form action={deleteMemoryAction}>
                            <input type="hidden" name="memoryId" value={row.id} />
                            <Button type="submit" variant="secondary" size="sm" pendingLabel="Deleting…">
                              Delete
                            </Button>
                          </form>
                        </div>
                      </div>

                      {row.kind === "stated" && (
                        <form action={correctMemoryAction} className="mt-2 flex items-end gap-2 max-w-md">
                          <input type="hidden" name="memoryId" value={row.id} />
                          <div className="flex-1">
                            <Field label="Correct this value">
                              <Input name="value" defaultValue={row.value} maxLength={200} />
                            </Field>
                          </div>
                          <Button type="submit" variant="secondary" size="sm" pendingLabel="Saving…">
                            Save
                          </Button>
                        </form>
                      )}
                    </div>
                  ))}
                </div>
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
