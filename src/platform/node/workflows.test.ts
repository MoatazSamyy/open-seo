import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testDb = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb: create } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return create();
});

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/db", () => ({
  db: testDb.db,
  withPgClient: <T>(fn: () => Promise<T>) => fn(),
}));

import { NonRetryableError } from "./cloudflare-workflows";
import { startWorkflowRunner } from "./workflow-runner";
import { createWorkflowBinding } from "./workflows";

type Run = (
  event: WorkflowEvent<never>,
  step: WorkflowStep,
) => Promise<unknown>;

// The runner is process-wide, so one runner serves every test through this
// registry, and each test registers its own workflow name.
const workflows: Record<string, new () => { run: Run }> = {};
function register(name: string, run: Run) {
  workflows[name] = class {
    run = run;
  };
  return createWorkflowBinding(name);
}

async function settle(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeAll(() => {
  vi.useFakeTimers({ now: new Date("2026-10-01T00:00:00Z") });
  startWorkflowRunner({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test workflows need neither ctx nor env
    workflows: workflows as unknown as Parameters<
      typeof startWorkflowRunner
    >[0]["workflows"],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- unused by the test workflows
    env: {} as Env,
  });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("Node workflows", () => {
  it("replays saved steps after a sleep instead of running them again", async () => {
    let fetches = 0;
    const binding = register("SLEEPY", async (event, step) => {
      const first = await step.do("fetch", () => {
        fetches += 1;
        return Promise.resolve(`page-${fetches}`);
      });
      await step.sleep("wait", "1 minute");
      return { first, instanceId: event.instanceId };
    });

    const instance = await binding.create({ id: "run-1" });
    await settle(3_000);
    expect(await instance.status()).toMatchObject({ status: "waiting" });

    await settle(61_000);
    expect(await instance.status()).toEqual({
      status: "complete",
      output: { first: "page-1", instanceId: "run-1" },
    });
    expect(fetches).toBe(1);
  });

  it("retries a failing step, but fails at once on a NonRetryableError", async () => {
    let attempts = 0;
    const retried = register("FLAKY", async (_event, step) =>
      step.do(
        "flaky",
        { retries: { limit: 2, delay: "1 second", backoff: "constant" } },
        () => {
          attempts += 1;
          return attempts < 3
            ? Promise.reject(new Error("upstream down"))
            : Promise.resolve("ok");
        },
      ),
    );
    const fatal = register("FATAL", async (_event, step) =>
      step.do("fatal", () =>
        Promise.reject(new NonRetryableError("bad input")),
      ),
    );

    const flaky = await retried.create();
    const broken = await fatal.create();
    await settle(5_000);

    expect(await flaky.status()).toEqual({ status: "complete", output: "ok" });
    expect(attempts).toBe(3);
    expect(await broken.status()).toMatchObject({
      status: "errored",
      error: { message: "bad input" },
    });
  });

  it("stops a terminated run before its next step", async () => {
    let secondStepRan = false;
    const binding = register("STOPPABLE", async (_event, step) => {
      await step.sleep("pause", "1 minute");
      await step.do("after", () => {
        secondStepRan = true;
        return Promise.resolve(null);
      });
    });

    const instance = await binding.create();
    await settle(3_000);
    await instance.terminate();
    await settle(61_000);

    expect(await instance.status()).toEqual({ status: "terminated" });
    expect(secondStepRan).toBe(false);
  });
});
