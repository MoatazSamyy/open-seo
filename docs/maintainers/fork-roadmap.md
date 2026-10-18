# Fork roadmap

This fork's plan for fixing the weaknesses found when reviewing upstream
OpenSEO. Each milestone ships on its own branch and keeps upstream's
invariants (tenant scoping, SQLite/Postgres parity, one billing seam).

## Milestone 1 — Swappable data providers

Every SEO data call goes to DataForSEO today. The goal is that each kind of
data has a provider seam, so a second vendor can serve it and one vendor's
outage or price change doesn't take the product down.

| Step | Data                                  | Alternative provider | Status   |
| ---- | ------------------------------------- | -------------------- | -------- |
| 1a   | Live organic SERPs + live rank checks | Serper.dev           | Done     |
| 1b   | Keyword metrics (volume, CPC)         | Keywords Everywhere  | Done     |
| 1c   | Backlinks summary                     | None fits yet        | Deferred |
| 1d   | Provider health + failover            | —                    | Done     |

**1a — SERP provider routing.** See
[`specs/0016-serp-provider-routing.md`](./specs/0016-serp-provider-routing.md).
`SERP_PROVIDER=serper` sends desktop organic SERP requests (keyword SERP
analysis, the `get_serp_results` MCP tool, live rank checks) to Serper.dev.
Everything else stays on DataForSEO.

**1b — Keyword metrics provider.** See
[`specs/0017-keyword-metrics-provider.md`](./specs/0017-keyword-metrics-provider.md).
`KEYWORD_METRICS_PROVIDER=keywords_everywhere` serves country-level volume,
CPC, competition, and trend from Keywords Everywhere. Difficulty and intent
stay Labs-only and are null for those rows. It costs more per keyword than
Labs, so it's a redundancy option that milestone 1d turns into a fallback.

**1c — Backlinks (deferred).** The backlinks pages need totals, rank, spam
scores, new/lost status, history, and filtered, sorted link lists. Keywords
Everywhere only returns raw link lists, and Moz only returns totals, so
neither can stand in for DataForSEO without breaking those pages. Revisit if
a provider with both appears, or as a Moz-backed summary card.

**1d — Failover.** See
[`specs/0018-provider-failover.md`](./specs/0018-provider-failover.md).
When the primary provider fails on its own side, the request retries once on
the other configured provider, and a failed provider goes last for a minute.

## Milestone 2 — Real login for self-hosting

Done. See
[`specs/0019-self-host-password-login.md`](./specs/0019-self-host-password-login.md).
`AUTH_MODE=password` adds email/password sign-in with sign-up limited to
`ALLOWED_SIGNUP_EMAILS` and one shared workspace per install, without the
hosted billing, captcha, or email. Follow-up: serve MCP in password mode.

## Milestone 3 — Run without Cloudflare emulation

Today the Docker image installs dependencies, then **builds the app on first
start** (client settings like `AUTH_MODE` are baked in at build time), then
runs `vite preview`, which runs the Worker inside Miniflare (workerd). A
5-minute loop calls the `scheduled` handler over HTTP. The goal is a Node
server that runs on any host with only Postgres next to it.

### What depends on the Cloudflare runtime

| Dependency                                    | Where it's used                                                                          | Size            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------- |
| `env` / `waitUntil` from `cloudflare:workers` | Config reads and background work, about 50 files                                         | Mechanical      |
| KV (`KV`, `OAUTH_KV`)                         | Caches, audit progress, SERP locations, OAuth, referrals (~28 uses)                      | Small interface |
| R2                                            | Response cache, AI-visibility exports and retention, GDPR erasure (5 files)              | Small interface |
| D1                                            | Default local database (Postgres already supported)                                      | Drop on Node    |
| Workflows (3)                                 | Site audit, rank checks, AI visibility: `step.do`, `step.sleep`, create/status/terminate | Durable runner  |
| Durable Object + Agents SDK                   | SAM chat (`@cloudflare/think`, `useAgent` WebSockets)                                    | Hardest         |
| Service binding + Browser Rendering           | The separate site-audit worker                                                           | Merge on Node   |
| Cron triggers                                 | Scheduled rank checks, audit reconciler, OAuth purge                                     | Timer           |
| Build-time client env                         | `AUTH_MODE`, PostHog, Turnstile, email bypass baked into the client                      | Runtime config  |

### Phases

- **3a — Prebuilt image.** Done. The server writes the client settings into
  each page (`src/lib/client-config.ts`) instead of baking them into the
  build, so the Dockerfile builds once and the container starts without
  rebuilding. Still runs workerd. Independent of everything below.
- **3b — Platform layer.** Done. `src/platform/runtime.ts` is the seam for
  config (`getConfig`), `waitUntil`, `kv`, and `blobs`, with the Cloudflare
  implementation. A lint rule (`no-restricted-imports` in `.oxlintrc.json`)
  keeps everything else off `cloudflare:workers`, except the files listed
  there that still need Workflow, Durable Object, service, or Browser
  bindings; 3c-3e move those.
- **3c — Node runtime.** Done, experimental. See
  [`specs/0020-node-runtime.md`](./specs/0020-node-runtime.md) and
  [`../SELF_HOSTING_NODE.md`](../SELF_HOSTING_NODE.md). `pnpm build:node` and
  `pnpm start:node` run the app on Node with Postgres, a `platform_kv` table,
  file blobs, and a cron timer. Workflow-backed features fail with a clear
  error until 3d.
- **3d — Durable workflows on Postgres.** A runner that persists `step.do`
  results and `step.sleep` wake-up times in Postgres, with the same API the
  three workflows use, plus create/status/terminate.
- **3e — Site audit in-process.** Run the audit engine in the main process
  on Node; JavaScript rendering through Context.dev only.
- **3f — SAM chat without Durable Objects.** Replace the Agents SDK's
  Durable Object with Postgres-stored chat history and a WebSocket or SSE
  endpoint. Until then, SAM is off on the Node runtime.

3a ships on its own. 3b–3e together make the Node image usable without SAM;
3f brings SAM back.

## Milestone 4 — Product gaps

- Content briefs (search intent, top-page outlines, topics, questions), in
  the app and over MCP.
- Rank-drop and new-audit-issue alerts, plus a weekly summary email.
- Agency workspaces with white-label share links.
