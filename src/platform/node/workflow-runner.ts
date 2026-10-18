import { and, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import {
  decode,
  encode,
  LEASE_MS,
  NodeWorkflowStep,
  RunSuspended,
  setRunnerNudge,
  store,
  updateInstance,
  type WorkflowClass,
} from "./workflows";

// Runs due workflow instances in this process (fork milestone 3d): polls for
// queued, woken, or abandoned instances, claims each with a lease, and runs
// it. See ./workflows.ts for the instance and step model.

const POLL_INTERVAL_MS = 2_000;
const MAX_CONCURRENT_RUNS = 4;

/**
 * Starts running due instances of the given workflows (keyed by binding
 * name) in this process. Call once at startup.
 */
export function startWorkflowRunner(options: {
  workflows: Record<string, WorkflowClass>;
  env: Env;
}) {
  let active = 0;
  let polling = false;

  async function execute(row: {
    id: string;
    workflow: string;
    instanceId: string;
    params: string;
    createdAt: Date;
  }) {
    const Workflow = options.workflows[row.workflow];
    const { db, withPgClient, steps } = await store();
    if (!Workflow) {
      await updateInstance(row.id, {
        status: "errored",
        errorName: "Error",
        errorMessage: `No workflow registered for ${row.workflow}`,
        leaseUntil: null,
      });
      return;
    }
    const savedRows = await withPgClient(() =>
      db.select().from(steps).where(eq(steps.instancePk, row.id)),
    );
    const step = new NodeWorkflowStep(
      row.id,
      new Map(savedRows.map((saved) => [saved.name, saved])),
    );
    const ctx = {
      waitUntil: (promise: Promise<unknown>) =>
        void promise.catch((error: unknown) => {
          console.error("[workflows] background work failed:", error);
        }),
      passThroughOnException: () => undefined,
      props: {},
    };
    try {
      const output = await withPgClient(() =>
        new Workflow(ctx, options.env).run(
          {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- params were stored from this workflow's create() call
            payload: decode(row.params) as never,
            timestamp: row.createdAt,
            instanceId: row.instanceId,
          },
          step,
        ),
      );
      await updateInstance(row.id, {
        status: "complete",
        output: encode(output),
        wakeAt: null,
        leaseUntil: null,
      });
    } catch (error) {
      if (error instanceof RunSuspended) return;
      await updateInstance(row.id, {
        status: "errored",
        errorName: error instanceof Error ? error.name : "Error",
        errorMessage: error instanceof Error ? error.message : String(error),
        leaseUntil: null,
      });
      console.error(
        `[workflows] ${row.workflow} ${row.instanceId} failed:`,
        error,
      );
    }
  }

  async function poll() {
    if (polling || active >= MAX_CONCURRENT_RUNS) return;
    polling = true;
    try {
      const { db, withPgClient, instances } = await store();
      const now = new Date();
      const due = and(
        inArray(instances.status, ["queued", "running", "waiting"]),
        or(isNull(instances.wakeAt), lte(instances.wakeAt, now)),
        or(isNull(instances.leaseUntil), lt(instances.leaseUntil, now)),
      );
      const candidates = await withPgClient(() =>
        db
          .select({ id: instances.id })
          .from(instances)
          .where(due)
          .orderBy(instances.createdAt)
          .limit(MAX_CONCURRENT_RUNS - active),
      );
      for (const candidate of candidates) {
        // Claim it; another process may have taken it since the select.
        const [claimed] = await withPgClient(() =>
          db
            .update(instances)
            .set({
              status: "running",
              wakeAt: null,
              leaseUntil: new Date(Date.now() + LEASE_MS),
              updatedAt: new Date(),
            })
            .where(and(eq(instances.id, candidate.id), due))
            .returning(),
        );
        if (!claimed) continue;
        active += 1;
        void execute(claimed).finally(() => {
          active -= 1;
          void poll();
        });
      }
    } catch (error) {
      console.error("[workflows] poll failed:", error);
    } finally {
      polling = false;
    }
  }

  setRunnerNudge(() => void poll());
  setInterval(() => void poll(), POLL_INTERVAL_MS);
  void poll();
}
