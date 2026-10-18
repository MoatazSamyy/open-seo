# 0020 — Node runtime

## Status

Proposed (October 2026), fork milestone 3c. Experimental.

## Context

OpenSEO is a Cloudflare Worker. Self-hosters outside Cloudflare run it in
Docker through Miniflare, the local Workers runtime. Milestone 3b put config,
background work (`waitUntil`), KV, and blob storage behind
`src/platform/runtime.ts`. This milestone adds a second implementation of
that seam and a Node server, so the app can run on a plain Node host with only
Postgres beside it.

## Decision

1. **One codebase, two builds.** `vite.config.ts` builds the Worker as before.
   `vite.node.config.ts` builds the same app without the Cloudflare plugin,
   with `src/server.node.ts` as the server entry, into `dist-node/`.
   `scripts/node-server.mjs` serves it with srvx.
2. **The runtime is swapped at build time.** The Node build aliases
   `@/platform/runtime` to `runtime.node.ts`. Both implement the shapes in
   `src/platform/types.ts`, so callers can't tell them apart.
   - Config reads `process.env`.
   - `waitUntil` lets the work run on and logs a failure.
   - KV is a `platform_kv` table (key, value, expiry). Expired rows read as
     missing. Lists use a key range rather than `LIKE`, so `%` and `_` in a
     prefix match literally.
   - Blobs are files under `BLOB_DIR`, with metadata in a sidecar JSON file.
     Keys are split on `/` and any empty, `.`, or `..` segment is rejected.
3. **Postgres only, one pool per process.** On Workers each request opens its
   own Postgres client because sockets can't cross requests. Node keeps one
   pooled client for the process. The runtime says which (`postgresClientLifetime`),
   and it also supplies the connection string: the Hyperdrive binding on
   Workers, `POSTGRES_DATABASE_URL` on Node.
4. **Missing bindings fail when used, not at startup.** Files that still need
   Workflow, Durable Object, service, or Browser bindings import
   `cloudflare:workers`. The Node build aliases it to a stand-in that reads
   strings from `process.env` and returns, for each missing binding, an object
   that throws an error naming the milestone that will add it. The app boots
   and only the affected feature fails.
5. **Shared request and cron code.** The TanStack app handler with its
   `frame-ancestors` policy, and the five-minute cron work, moved to
   `src/server/entry/` so both entries use the same code. The Node launcher
   runs the cron on a timer, one run at a time.

## Alternatives considered

- **Keep Miniflare in the container.** Works today, but it's a local
  development runtime, and it ties every self-host to Workers-only APIs.
- **A KV table only for Postgres.** Rejected: the dual-dialect rule keeps both
  schemas identical. The table is unused, and harmless, on D1.
- **Blob storage in Postgres.** Rejected for now: exports and cached
  responses are files by nature, and a volume is simpler to inspect and back
  up. An S3-compatible store can implement the same shape later.

## Consequences

- With this milestone, Node runs everything except Workflows (rank checks, AI
  visibility, site audits), SAM, hosted mode, and GDPR erasure. Milestones 3d
  to 3f add the rest.
- `platform_kv` exists on D1 too, with nothing in it.
- Node deployments must keep `BLOB_DIR` on persistent storage.
