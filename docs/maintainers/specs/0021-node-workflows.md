# 0021 — Durable workflows on Postgres

## Status

Proposed (October 2026), fork milestone 3d. Experimental, Node runtime only.

## Context

Rank checks, AI-visibility runs, and site audits are Cloudflare Workflows:
classes whose `run(event, step)` does its work in named `step.do` calls, waits
with `step.sleep` / `step.sleepUntil`, and is started and inspected through a
binding (`create`, `get`, `status`, `terminate`, `restart`). The Node runtime
(spec 0020) had no Workflows, so those features failed there.

## Decision

1. **Same classes, same API.** The workflow classes are unchanged. On Node,
   the `cloudflare:workers` stand-in returns a Postgres-backed binding for
   each workflow, and the Node entry hands the three classes to a runner in
   the same process.
2. **Cloudflare's execution model.** Each finished `step.do` result is saved.
   A run resumes by calling `run()` again from the top; finished steps return
   their saved result instead of running, so code between steps must be
   deterministic, as on Cloudflare. A step is identified by its name.
3. **Sleeps suspend the run.** A sleep saves its wake-up time the first time
   it's reached (so replays don't push it back), marks the instance
   `waiting`, and ends the attempt. The runner picks the instance up once the
   time has passed.
4. **Retries and timeouts follow the step config.** `retries` (limit, delay,
   constant/linear/exponential backoff) and `timeout` behave as on Cloudflare,
   with Cloudflare's defaults (5 retries, 10 seconds exponential, 10-minute
   timeout). A `NonRetryableError` fails the instance at once.
5. **Leases instead of a scheduler service.** The runner polls every two
   seconds for queued, woken, or abandoned instances and claims each with a
   15-minute lease that is renewed at every step. If the process dies, the
   lease expires and the next poll resumes the instance from its last saved
   step. A creation or restart wakes the runner immediately. At most four
   instances run at once per process.
6. **Terminate is checked between steps.** `terminate()` marks the instance;
   a running attempt stops before its next step.
7. **State lives in two tables**, `workflow_instances` and `workflow_steps`,
   declared for both dialects like every other table. Params, outputs, and
   step results are stored as opaque JSON, as Workflows stores them.

## Alternatives considered

- **A job-queue library (pg-boss, graphile-worker).** They queue jobs, but the
  workflows need step memoization and replay, which would still have to be
  written on top. The runner is small enough to own.
- **Running each step as its own job.** Rejected: it would need the workflows
  rewritten as state machines, and they'd diverge from the Cloudflare code.

## Consequences

- Rank checks and AI-visibility runs work on Node, including scheduled ones
  and the polling waits inside them.
- Site audits start on the runner but still need the crawl scratchpad and
  audit engine (milestone 3e).
- `step.waitForEvent` is not supported; no workflow uses it.
- Throughput is bounded per process; more instances need more Node
  processes, which the leases already allow.
