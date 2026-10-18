# 0022 — Site audits on Node

## Status

Proposed (October 2026), fork milestone 3e. Experimental, Node runtime only.

## Context

A site audit is a Workflow (spec 0021) that keeps its crawl frontier, link
graph, and throttle state in `AuditScratchpad`, a SQLite-backed Durable
Object, one per audit. On Cloudflare the scratchpad and the audit engine
service (which wipes a scratchpad) live in a separate audit worker, and
rendering can use the Browser binding. None of these exist on Node.

## Decision

1. **Run the same Durable Object class in-process.** The Node entry builds a
   namespace binding for `AuditScratchpad` that keeps one instance per audit
   id and calls its methods directly instead of over RPC. The class is
   unchanged.
2. **Its storage is a SQLite file per object.** `ctx.storage.sql.exec` runs on
   `node:sqlite` against `<DURABLE_OBJECT_DIR>/AUDIT_SCRATCHPAD/<id>.sqlite`,
   so the scratchpad's SQLite statements run as written. `storage.get`/`put`
   use a small table in the same file, `databaseSize` reads SQLite's page
   count, and `deleteAll()` deletes the file.
3. **Workers' concurrency gate is kept.** Calls wait for the work the
   constructor started with `blockConcurrencyWhile`, so the cleanup alarm the
   constructor sets can't race a `destroy()` and outlive the object.
4. **Alarms are files the cron fires.** `setAlarm` writes a timestamp file
   beside the database; the Node five-minute cron runs every due alarm. This
   keeps the scratchpad's 7-day self-cleanup for abandoned audits.
5. **The audit engine is a local object.** `AUDIT_ENGINE` is the same
   `AuditEngine` entrypoint class, constructed in-process.
6. **No browser.** `BROWSER` is absent on Node, as in Docker, so the existing
   fallback applies: JavaScript rendering only through a Context.dev key.

## Alternatives considered

- **Port the scratchpad to Postgres tables.** Rejected: its SQL is SQLite
  (`INSERT OR IGNORE`, `FILTER`, upserts tuned to SQLite) and it relies on a
  private database per audit that's cheap to drop. Translating it would fork
  the crawl logic between runtimes.
- **An in-memory scratchpad.** Rejected: audits resume after a restart from
  saved workflow steps, and their crawl state has to survive with them.

## Consequences

- Site audits work on Node, including resume after a restart.
- `DURABLE_OBJECT_DIR` must be on persistent storage, and only one Node
  process may use it: objects are cached per process, so two processes would
  each hold their own view of the same audit.
- `node:sqlite` is marked experimental in Node 22 and prints a warning at
  startup.
