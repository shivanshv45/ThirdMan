import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { getTasksForMerchant } from "@/lib/dashboard";
import { cancelTaskAction, retryTaskAction } from "../actions";
import { PageHeader, Surface, Button, EmptyState, DecisionBadge, type Decision } from "@/components/ui";

function formatDate(d: Date): string {
  return new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

const STATUS_DECISION: Record<string, Decision> = {
  succeeded: "allow",
  failed: "deny",
  cancelled: "deny",
  pending: "escalate",
  waiting: "escalate",
  claimed: "escalate",
};

/**
 * Layer 17-4: what the runtime is doing, right now — every real
 * agent_tasks row and its real step history. No fabricated progress: a
 * step count is real (agent_task_steps), never an estimated percentage
 * or a spinner implying work between ticks when nothing is happening.
 */
export default async function TasksPage() {
  const merchant = await getSessionMerchant();
  if (!merchant) redirect("/login");

  const tasks = await getTasksForMerchant(merchant.id);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Agent Runtime"
        description="Long-running work that doesn't fit inside a single request — a durable state machine advanced by the same scheduler that drains notifications and webhooks. Every step here still goes through the gate under the task's own agent identity; a task carries no authority a direct request wouldn't have."
      />

      {tasks.length === 0 ? (
        <EmptyState
          title="No tasks yet"
          description="A task is created when a long-running sequence begins — for example, a recovery pipeline run for a failed payment. Nothing has started one yet."
        />
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <Surface key={task.id} variant="raised" className="p-5">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-[var(--t-h4)] font-medium text-on-ink truncate">{task.kind}</span>
                  <DecisionBadge decision={STATUS_DECISION[task.status] ?? "n/a"} label={task.status} compact />
                </div>
                {task.status === "failed" && (
                  <form action={retryTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <Button type="submit" variant="secondary" size="sm" pendingLabel="Retrying…">
                      Retry
                    </Button>
                  </form>
                )}
                {(task.status === "pending" || task.status === "waiting" || task.status === "claimed") && (
                  <form action={cancelTaskAction}>
                    <input type="hidden" name="taskId" value={task.id} />
                    <Button type="submit" variant="secondary" size="sm" pendingLabel="Cancelling…">
                      Cancel
                    </Button>
                  </form>
                )}
              </div>

              <p className="mt-3 text-sm text-on-ink-dim">
                Attempt <span className="font-mono text-on-ink">{task.attemptCount}</span> of{" "}
                <span className="font-mono text-on-ink">{task.maxAttempts}</span>
                {task.status === "waiting" && (
                  <>
                    {" "}
                    — next run at <span className="font-mono text-on-ink">{formatDate(task.runAfter)}</span>
                  </>
                )}
              </p>
              <p className="mt-1 text-xs text-on-ink-faint">
                Created {formatDate(task.createdAt)} · updated {formatDate(task.updatedAt)}
              </p>

              {task.steps.length > 0 && (
                <details className="mt-4 pt-4 border-t border-ink-line-soft group">
                  <summary className="cursor-pointer text-sm text-on-ink-dim hover:text-on-ink">
                    Step history ({task.steps.length})
                  </summary>
                  <div className="mt-3 space-y-2">
                    {task.steps.map((step) => (
                      <div key={step.id} className="text-xs font-mono text-on-ink-faint">
                        <div className="flex items-center justify-between gap-3">
                          <span>
                            {step.stepName} — {step.outcome}
                            {step.durationMs !== null ? ` (${step.durationMs}ms)` : ""}
                          </span>
                          <span>{formatDate(step.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 text-on-ink-faint/80 normal-case font-sans">{step.reason}</p>
                        {step.moneyActionId && (
                          <a href={`/dashboard/explain?moneyActionId=${step.moneyActionId}`} className="text-[var(--allow-bright)] hover:underline">
                            View the money action this step took →
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
