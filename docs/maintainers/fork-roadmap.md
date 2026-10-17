# Fork roadmap

This fork's plan for fixing the weaknesses found when reviewing upstream
OpenSEO. Each milestone ships on its own branch and keeps upstream's
invariants (tenant scoping, SQLite/Postgres parity, one billing seam).

## Milestone 1 — Swappable data providers

Every SEO data call goes to DataForSEO today. The goal is that each kind of
data has a provider seam, so a second vendor can serve it and one vendor's
outage or price change doesn't take the product down.

| Step | Data                                  | Alternative provider | Status      |
| ---- | ------------------------------------- | -------------------- | ----------- |
| 1a   | Live organic SERPs + live rank checks | Serper.dev           | In progress |
| 1b   | Keyword metrics (volume, CPC)         | To be chosen         | Planned     |
| 1c   | Backlinks summary                     | To be chosen         | Planned     |
| 1d   | Provider health + failover            | —                    | Planned     |

**1a — SERP provider routing.** See
[`specs/0016-serp-provider-routing.md`](./specs/0016-serp-provider-routing.md).
`SERP_PROVIDER=serper` sends desktop organic SERP requests (keyword SERP
analysis, the `get_serp_results` MCP tool, live rank checks) to Serper.dev.
Everything else stays on DataForSEO.

**1b — Keyword metrics seam.** Pull the volume/CPC/competition fields out of
the Labs row shape into a provider-neutral row, so a second source can fill
them. Difficulty and intent stay Labs-only and stay nullable, which the UI
already handles for Google-Ads-only countries.

**1c — Backlinks seam.** Same pattern for the backlinks summary (referring
domains, backlinks, rank). Lists of individual links stay on DataForSEO.

**1d — Failover.** When the primary provider returns an upstream error,
retry once on the other configured provider and record which one answered.

## Milestone 2 — Real login for self-hosting

Docker self-hosting runs with `AUTH_MODE=local_noauth`. Add a self-host mode
that uses the existing better-auth email/password flow, without the hosted
billing and email-verification dependencies.

## Milestone 3 — Run without Cloudflare emulation

Replace Workflows and Durable Objects with a Postgres-backed job queue and a
plain WebSocket server behind the same interfaces, so the Node image runs on
any host. Ship a prebuilt image instead of building on first start.

## Milestone 4 — Product gaps

- Content briefs (search intent, top-page outlines, topics, questions), in
  the app and over MCP.
- Rank-drop and new-audit-issue alerts, plus a weekly summary email.
- Agency workspaces with white-label share links.
