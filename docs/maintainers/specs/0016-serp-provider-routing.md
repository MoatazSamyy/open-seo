# 0016 — SERP provider routing

## Status

Proposed (October 2026), fork milestone 1a.

## Context

Every Google SERP the app reads comes from DataForSEO's SERP API: keyword
SERP analysis, the `get_serp_results` MCP tool, and rank tracking. A
DataForSEO outage, price change, or account problem stops all three. Live
organic SERPs are also the easiest data to get from someone else: several
vendors sell the same Google results page, and the fields we use (type,
position, title, URL, domain, snippet) are common to all of them.

## Decision

1. **One setting picks the SERP provider.** `SERP_PROVIDER` is `dataforseo`
   (the default) or `serper`. `serper` also needs `SERPER_API_KEY`. An
   unknown value, or `serper` without a key, falls back to DataForSEO and
   logs a warning instead of breaking SERP features.
2. **Only desktop organic SERPs are routed.** The Serper adapter sends
   desktop queries only, so mobile requests stay on DataForSEO. Maps, Local
   Finder, and queued (task_post) SERPs have no Serper equivalent and stay
   on DataForSEO.
3. **The adapter returns DataForSEO's item shape.** Serper results are mapped
   to the same `SerpLiveItem` records the callers already read, so nothing
   above the client changes. Organic positions are counted across pages by
   the adapter, and the answer box, People Also Ask, knowledge graph, top
   stories, places, images, videos, and related searches become items with
   DataForSEO's type names, so rank tracking's SERP-feature list keeps
   working. Serper has no traffic estimates or backlink counts, so those
   fields stay empty.
4. **Pages are fetched one at a time, 10 results each.** Depth works as it
   does on DataForSEO (rounded up to pages of 10, capped at 100). A rank
   check stops after the page where the target domain shows up as an organic
   result, the same as DataForSEO's `stop_crawl_on_match`.
5. **Billing goes through the same seam.** Serper calls return the same
   billing envelope as DataForSEO calls, with the credits Serper reports
   priced at its highest public per-credit rate, so the hosted metering,
   holds, and settles are unchanged. The reserved estimate is the larger of
   the DataForSEO and Serper estimates.
6. **Scheduled rank checks use the live path under Serper.** DataForSEO's
   task queue is what makes scheduled checks cheap; Serper has no queue and
   answers in seconds, so scheduled runs call it live. Pairs a live run
   missed still go to the DataForSEO queue, which doubles as a fallback
   provider.

## Alternatives considered

- **A full provider interface for every DataForSEO section now.** Rejected
  for this step: keyword, domain, and backlink data have no drop-in
  equivalent, and an interface with one implementation is speculative.
  Those seams come one at a time with a real second provider (fork
  milestones 1b and 1c).
- **Per-project provider choice.** Rejected: the provider is an operator's
  account and key, not a user preference, and a mix makes cached snapshots
  harder to compare.
- **Automatic failover between providers.** Deferred to milestone 1d; it
  needs per-provider health tracking so a hard outage doesn't double every
  call's latency.

## Consequences

- With `SERP_PROVIDER=serper`, desktop SERP analysis and rank checks no
  longer depend on DataForSEO being up. Keyword research, domain, backlink,
  local, and AI-visibility features still do.
- Serper SERP items have no ETV, paid-traffic cost, or backlink counts, so
  those columns are empty on SERP analysis while Serper is active.
- Scheduled rank checks with mobile devices call DataForSEO live instead of
  queued for the mobile half while Serper is active.
