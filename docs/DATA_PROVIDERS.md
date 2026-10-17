# Data providers

OpenSEO gets its SEO data from DataForSEO. You can move two kinds of data to
other providers:

- **Google search results (SERPs)** to [Serper.dev](https://serper.dev).
- **Keyword metrics** (search volume, CPC, competition, monthly trend) to
  [Keywords Everywhere](https://keywordseverywhere.com).

You still need `DATAFORSEO_API_KEY`: everything else in the app uses it.

## SERPs: Serper.dev

| Feature                                | With `SERP_PROVIDER=serper` |
| -------------------------------------- | --------------------------- |
| SERP analysis (keyword research page)  | Serper                      |
| `get_serp_results` MCP tool, desktop   | Serper                      |
| Rank checks, desktop                   | Serper                      |
| Anything mobile                        | DataForSEO                  |
| Local SEO (Maps, Local Finder, grids)  | DataForSEO                  |
| Keywords, domains, backlinks, AI, etc. | DataForSEO                  |

Set it up:

1. Create a Serper.dev account and copy your API key.
2. Add both values to your env file (`.env` for Docker, `.env.selfhost` for
   Cloudflare), then restart or redeploy:

   ```sh
   SERP_PROVIDER=serper
   SERPER_API_KEY=your-serper-key
   ```

Differences you'll notice:

- **Scheduled rank checks run live.** Serper has no task queue, so scheduled
  checks use the same live path as manual checks. Any keyword the live check
  misses is retried through DataForSEO's queue.
- **Some SERP columns are empty.** Serper doesn't return traffic estimates
  (ETV), paid traffic cost, or backlink counts for each result.
- **Positions count organic results only.** Serper doesn't say where SERP
  features sit between results, so only the organic position is shown.

## Keyword metrics: Keywords Everywhere

| Feature                                       | With `KEYWORD_METRICS_PROVIDER=keywords_everywhere` |
| --------------------------------------------- | --------------------------------------------------- |
| `get_keyword_metrics` MCP tool, country-level | Keywords Everywhere                                 |
| Metric refresh for saved and tracked keywords | Keywords Everywhere                                 |
| City, county, or region (local) metrics       | DataForSEO                                          |
| Countries Keywords Everywhere doesn't cover   | DataForSEO                                          |
| Keyword research (finding new keyword ideas)  | DataForSEO                                          |

Set it up:

1. Get an API key from your Keywords Everywhere account (any paid plan).
2. Add both values to your env file, then restart or redeploy:

   ```sh
   KEYWORD_METRICS_PROVIDER=keywords_everywhere
   KEYWORDS_EVERYWHERE_API_KEY=your-keywords-everywhere-key
   ```

Differences you'll notice:

- **No keyword difficulty or search intent.** Keywords Everywhere doesn't
  provide them, so those columns are empty for metrics it serves, the same as
  for countries served from Google Ads data.
- **It can cost more.** Keywords Everywhere charges one credit per keyword.
  For large keyword lists that is usually more than DataForSEO, so it works
  best as a second source rather than a way to save money.
- **Country only.** Keywords Everywhere has no language or city targeting.
  OpenSEO checks its country list and keeps everything else on DataForSEO.

## Automatic failover

If you set API keys for both providers of the same data, OpenSEO uses the
second one as a backup. When the main provider is down, rate-limits you, or
(for DataForSEO) rejects your login, the same request is retried once on the
other one.

| Data                          | Main provider                                      | Backup                                                 |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| Desktop SERPs                 | `SERP_PROVIDER` (DataForSEO by default)            | The other, if its key is set                           |
| Country-level keyword metrics | `KEYWORD_METRICS_PROVIDER` (DataForSEO by default) | The other, if its key is set and it covers the country |

So setting only `SERPER_API_KEY` (without `SERP_PROVIDER`) keeps DataForSEO
as the main SERP provider and adds Serper as its backup. The same goes for
`KEYWORDS_EVERYWHERE_API_KEY`.

After a provider fails, OpenSEO tries the other one first for the next
minute. Each failover is logged as a `provider-failover:` warning. Mobile
SERPs, local keyword metrics, and everything else have no backup.

## Costs and misconfiguration

Cost estimates in the app use DataForSEO prices. Serper and Keywords
Everywhere bill your accounts with them directly, so what you pay can differ
from the estimate the app shows.

If a provider setting has no matching API key, or the value isn't
recognised, OpenSEO logs a warning and keeps using DataForSEO.
