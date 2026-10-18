import { randomUUID } from "node:crypto";
import type {
  WorkflowEvent,
  WorkflowSleepDuration,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepEvent,
} from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { NonRetryableError } from "./cloudflare-workflows";

// Durable workflows for the Node runtime (fork milestone 3d), standing in for
// Cloudflare Workflows. See docs/maintainers/specs/0021-node-workflows.md.
//
// Same model as Cloudflare: each `step.do` result is saved, and a run resumes
// by replaying `run()` from the top, getting saved results back instead of
// re-running finished steps. A sleep saves its wake-up time and suspends the
// run; the runner resumes it once that time has passed. Instances are leased
// while they run, so a crashed process's work is picked up again when the
// lease runs out.

type InstanceStatus = {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown";
  error?: { name: string; message: string };
  output?: unknown;
};

export type WorkflowClass = new (
  ctx: ExecutionContext,
  env: Env,
) => {
  run(event: WorkflowEvent<never>, step: WorkflowStep): Promise<unknown>;
};

const DEFAULT_RETRIES = {
  limit: 5,
  delay: "10 seconds",
  backoff: "exponential",
} as const;
const DEFAULT_STEP_TIMEOUT = "10 minutes";
export const LEASE_MS = 15 * 60_000;

const DURATION_UNITS_MS: Record<string, number> = {
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/** "4 minutes", "1 second", or a number of milliseconds. */
export function durationMs(duration: WorkflowSleepDuration | number): number {
  if (typeof duration === "number") return duration;
  const match = /^(\d+(?:\.\d+)?)\s+([a-z]+?)s?$/.exec(duration.trim());
  const unit = match ? DURATION_UNITS_MS[match[2]] : undefined;
  if (!match || unit === undefined) {
    throw new Error(`Unsupported workflow duration "${duration}"`);
  }
  return Number(match[1]) * unit;
}

const INSTANCE_STATUSES = new Set<string>([
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "unknown",
]);

function isInstanceStatus(value: string): value is InstanceStatus["status"] {
  return INSTANCE_STATUSES.has(value);
}

// Suspends a run without failing it: a sleep, or a terminate seen mid-run.
export class RunSuspended extends Error {}

// The db modules import the platform layer, so they're loaded on first use,
// not at import time, and then reused.
async function loadStore() {
  const { db, withPgClient } = await import("@/db");
  const schema = await import("@/db/schema");
  return {
    db,
    withPgClient,
    instances: schema.workflowInstances,
    steps: schema.workflowSteps,
  };
}

let storeModules: ReturnType<typeof loadStore> | null = null;

export function store() {
  storeModules ??= loadStore();
  return storeModules;
}

export function encode(value: unknown): string {
  return JSON.stringify({ value });
}

export function decode(text: string | null): unknown {
  if (text === null) return undefined;
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null
    ? Reflect.get(parsed, "value")
    : undefined;
}

async function findInstance(workflow: string, instanceId: string) {
  const { db, withPgClient, instances } = await store();
  return withPgClient(async () => {
    const [row] = await db
      .select()
      .from(instances)
      .where(
        and(
          eq(instances.workflow, workflow),
          eq(instances.instanceId, instanceId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function updateInstance(
  pk: string,
  values: Partial<{
    status: InstanceStatus["status"];
    errorName: string | null;
    errorMessage: string | null;
    output: string | null;
    wakeAt: Date | null;
    leaseUntil: Date | null;
  }>,
) {
  const { db, withPgClient, instances } = await store();
  await withPgClient(() =>
    db
      .update(instances)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(instances.id, pk)),
  );
}

function instanceHandle(workflow: string, instanceId: string, pk: string) {
  return {
    id: instanceId,
    async status(): Promise<InstanceStatus> {
      const row = await findInstance(workflow, instanceId);
      if (!row) return { status: "unknown" };
      return {
        status: isInstanceStatus(row.status) ? row.status : "unknown",
        ...(row.errorMessage !== null
          ? {
              error: {
                name: row.errorName ?? "Error",
                message: row.errorMessage,
              },
            }
          : {}),
        ...(row.output !== null ? { output: decode(row.output) } : {}),
      };
    },
    async terminate() {
      await updateInstance(pk, {
        status: "terminated",
        wakeAt: null,
        leaseUntil: null,
      });
    },
    async restart() {
      const { db, withPgClient, steps } = await store();
      await withPgClient(() =>
        db.delete(steps).where(eq(steps.instancePk, pk)),
      );
      await updateInstance(pk, {
        status: "queued",
        errorName: null,
        errorMessage: null,
        output: null,
        wakeAt: null,
        leaseUntil: null,
      });
      nudgeRunner();
    },
  };
}

/** The Workflow binding (create / get) for one workflow, backed by Postgres. */
export function createWorkflowBinding(workflow: string) {
  return {
    async create(options?: { id?: string; params?: unknown }) {
      const instanceId = options?.id ?? randomUUID();
      const { db, withPgClient, instances } = await store();
      const pk = randomUUID();
      const now = new Date();
      await withPgClient(() =>
        db.insert(instances).values({
          id: pk,
          workflow,
          instanceId,
          params: encode(options?.params ?? {}),
          status: "queued",
          createdAt: now,
          updatedAt: now,
        }),
      );
      nudgeRunner();
      return instanceHandle(workflow, instanceId, pk);
    },
    async get(instanceId: string) {
      const row = await findInstance(workflow, instanceId);
      if (!row) {
        throw new Error(`Workflow instance ${instanceId} not found`);
      }
      return instanceHandle(workflow, instanceId, row.id);
    },
  };
}

type StepRow = {
  result: string | null;
  wakeAt: Date | null;
  completedAt: Date | null;
};

/** The `step` handed to `run()`, replaying saved steps for one instance. */
export class NodeWorkflowStep implements WorkflowStep {
  constructor(
    private readonly pk: string,
    private readonly saved: Map<string, StepRow>,
  ) {}

  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<T>,
  ): Promise<T>;
  async do<T>(
    name: string,
    configOrCallback: WorkflowStepConfig | (() => Promise<T>),
    maybeCallback?: () => Promise<T>,
  ): Promise<T> {
    const [config, callback] =
      typeof configOrCallback === "function"
        ? [undefined, configOrCallback]
        : [configOrCallback, maybeCallback];
    if (!callback) throw new Error(`step.do("${name}") needs a callback`);

    const saved = this.saved.get(name);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a saved result is this step's own earlier return value
    if (saved?.completedAt) return decode(saved.result) as T;

    await this.beforeStep();
    const retries = config?.retries ?? DEFAULT_RETRIES;
    const timeoutMs = durationMs(config?.timeout ?? DEFAULT_STEP_TIMEOUT);
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await withTimeout(callback(), timeoutMs, name);
        await this.save(name, { result: encode(value), wakeAt: null });
        return value;
      } catch (error) {
        if (error instanceof NonRetryableError || attempt >= retries.limit) {
          throw error;
        }
        await delay(retryDelayMs(retries, attempt));
      }
    }
  }

  sleep = (name: string, duration: WorkflowSleepDuration): Promise<void> =>
    this.sleepUntil(name, Date.now() + durationMs(duration));

  sleepUntil = async (
    name: string,
    timestamp: Date | number,
  ): Promise<void> => {
    const saved = this.saved.get(name);
    if (saved?.completedAt) return;
    // The wake-up time is fixed the first time the sleep is reached, so a
    // relative sleep isn't pushed back on every replay.
    const wakeAt = saved?.wakeAt ?? new Date(timestamp);
    if (wakeAt.getTime() <= Date.now()) {
      await this.save(name, { result: null, wakeAt });
      return;
    }
    if (!saved) await this.save(name, { result: null, wakeAt }, false);
    await updateInstance(this.pk, {
      status: "waiting",
      wakeAt,
      leaseUntil: null,
    });
    throw new RunSuspended();
  };

  waitForEvent<T>(): Promise<WorkflowStepEvent<T>> {
    return Promise.reject(
      new Error("step.waitForEvent isn't supported on the Node runtime."),
    );
  }

  /** Stop a terminated run, and keep the lease alive through long runs. */
  private async beforeStep() {
    const { db, withPgClient, instances } = await store();
    const [row] = await withPgClient(() =>
      db
        .update(instances)
        .set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
        .where(eq(instances.id, this.pk))
        .returning({ status: instances.status }),
    );
    if (!row || row.status === "terminated") throw new RunSuspended();
  }

  private async save(
    name: string,
    values: { result: string | null; wakeAt: Date | null },
    completed = true,
  ) {
    const { db, withPgClient, steps } = await store();
    const completedAt = completed ? new Date() : null;
    await withPgClient(() =>
      db
        .insert(steps)
        .values({
          id: randomUUID(),
          instancePk: this.pk,
          name,
          ...values,
          completedAt,
        })
        .onConflictDoUpdate({
          target: [steps.instancePk, steps.name],
          set: { ...values, completedAt },
        }),
    );
    this.saved.set(name, { ...values, completedAt });
  }
}

function retryDelayMs(
  retries: NonNullable<WorkflowStepConfig["retries"]>,
  attempt: number,
) {
  const base = durationMs(retries.delay);
  if (retries.backoff === "exponential") return base * 2 ** attempt;
  if (retries.backoff === "linear") return base * (attempt + 1);
  return base;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, name: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Workflow step "${name}" timed out`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let nudge: (() => void) | null = null;

/** The runner registers how to wake it when there's new work. */
export function setRunnerNudge(fn: () => void) {
  nudge = fn;
}

function nudgeRunner() {
  nudge?.();
}
