# 0017 — Keyword metrics provider

## Status

Proposed (October 2026), fork milestone 1b.

## Context

Keyword metrics (search volume, CPC, competition, monthly trend) for known
keywords come from DataForSEO: Labs `keyword_overview` for most countries,
Google Ads `search_volume` for countries Labs doesn't cover and for local
(city, county, region) requests. They feed the `get_keyword_metrics` MCP
tool, saved-keyword metric refreshes, and rank tracking's keyword metrics.
`fetchKeywordMetricsForList` already turns both DataForSEO sources into one
provider-neutral `KeywordMetricRow`, so it is the natural seam for a second
provider.

Keywords Everywhere sells the same Google Keyword Planner numbers over a
simple API: up to 100 keywords per request, one credit per keyword, country
targeting only, and no keyword difficulty or search intent.

## Decision

1. **One setting picks the metrics provider.** `KEYWORD_METRICS_PROVIDER` is
   `dataforseo` (the default) or `keywords_everywhere`, which also needs
   `KEYWORDS_EVERYWHERE_API_KEY`. An unknown value or a missing key falls back
   to DataForSEO with a warning.
2. **Only country-level requests are routed.** A request with a
   `locationName` stays on DataForSEO's Google Ads path, which is the only
   source with sub-country targeting. A country Keywords Everywhere doesn't
   list in its `/countries` endpoint also stays on DataForSEO. The list is
   cached per isolate for a day; if it can't be read, requests go to
   DataForSEO.
3. **Keyword difficulty and intent are null.** Rows from Keywords Everywhere
   carry no KD, intent, or competition level, the same as Google-Ads-only
   rows. The UI and MCP tool descriptions already treat these as nullable.
   Merging in Labs KD was rejected: it would keep every request dependent on
   DataForSEO, which is what this provider exists to avoid.
4. **Keyword Planner data only.** Requests use `dataSource: gkp`, so volumes
   stay comparable with the Google-Ads-derived numbers DataForSEO shows.
5. **Billing goes through the same seam.** The call is an entry on the
   metered client, priced per keyword at a rate rounded up from Keywords
   Everywhere's smallest plan, and billed on the credits each response
   reports.
6. **Keyword discovery stays on DataForSEO.** Research (suggestions, ideas,
   related keywords) is a different product with no equivalent here.

## Consequences

- With the setting on, metric refreshes and `get_keyword_metrics` keep
  working for covered countries during a DataForSEO outage.
- KD and intent columns are empty for metrics Keywords Everywhere served,
  until a refresh runs on DataForSEO again.
- Per keyword, Keywords Everywhere usually costs more than Labs, so the
  setting is for redundancy rather than savings. Automatic failover (fork
  milestone 1d) is where it fits best.
