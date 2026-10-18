import { withPgClient } from "@/db";
import { isHostedAuthMode } from "@/lib/auth-mode";
import { reconcileStaleAudits } from "@/server/features/audit/services/auditReconciler";
import { runScheduledRankChecks } from "@/server/features/rank-tracking/services/scheduledRankChecks";
import { SCHEDULED_RANK_CHECKS_PAUSED } from "@/shared/rank-tracking-pause";

// The five-minute cron's work, shared by the Workers `scheduled` handler and
// the Node entry's timer.
export async function runFiveMinuteJobs(env: Env): Promise<void> {
  // Watchdog first: reconcile audits stuck in "running" whose workflow died
  // without reaching mark-failed (OOM/CPU kills, expired instances). Runs
  // before the rank loop so a slow tick can't delay or starve it. Its
  // failure is held until after the rank checks so it can't suppress them,
  // then rethrown so the invocation still reports as failed.
  let watchdogError: unknown;
  try {
    await withPgClient(() => reconcileStaleAudits());
  } catch (err) {
    watchdogError = err;
    console.error("[cron] Stale-audit reconcile failed:", err);
  }
  // Scope a per-request Postgres client for the cron run (no-op in D1 mode).
  const checks = await Promise.allSettled([
    SCHEDULED_RANK_CHECKS_PAUSED && isHostedAuthMode(env.AUTH_MODE)
      ? Promise.resolve()
      : withPgClient(() => runScheduledRankChecks(env)),
    withPgClient(async () => {
      const { runScheduledAiVisibility } =
        await import("@/server/features/ai-visibility/services/scheduledAiVisibility");
      await runScheduledAiVisibility();
    }),
  ]);
  for (const result of checks)
    if (result.status === "rejected") throw result.reason;
  if (watchdogError) throw watchdogError;
}
