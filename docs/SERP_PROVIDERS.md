# SERP providers

OpenSEO reads Google search results (SERPs) for SERP analysis on the keyword
research page, the `get_serp_results` MCP tool, and rank tracking. By default
they come from DataForSEO. You can serve desktop organic SERPs from
[Serper.dev](https://serper.dev) instead.

## What moves to Serper

| Feature                                | With `SERP_PROVIDER=serper` |
| -------------------------------------- | --------------------------- |
| SERP analysis (keyword research page)  | Serper                      |
| `get_serp_results` MCP tool, desktop   | Serper                      |
| Rank checks, desktop                   | Serper                      |
| Anything mobile                        | DataForSEO                  |
| Local SEO (Maps, Local Finder, grids)  | DataForSEO                  |
| Keywords, domains, backlinks, AI, etc. | DataForSEO                  |

You still need `DATAFORSEO_API_KEY`: the rest of the app uses it.

## Set it up

1. Create a Serper.dev account and copy your API key.
2. Add both values to your env file (`.env` for Docker, `.env.selfhost` for
   Cloudflare):

   ```sh
   SERP_PROVIDER=serper
   SERPER_API_KEY=your-serper-key
   ```

3. Restart (Docker) or redeploy (Cloudflare).

If `SERP_PROVIDER=serper` is set without `SERPER_API_KEY`, or the value isn't
recognised, OpenSEO logs a warning and keeps using DataForSEO.

## Differences you'll notice

- **Scheduled rank checks run live.** Serper has no task queue, so scheduled
  checks use the same live path as manual checks. Any keyword the live check
  misses is retried through DataForSEO's queue.
- **Some SERP columns are empty.** Serper doesn't return traffic estimates
  (ETV), paid traffic cost, or backlink counts for each result.
- **Positions count organic results only.** Serper doesn't say where SERP
  features sit between results, so only the organic position is shown.
- **Cost estimates use DataForSEO prices.** Serper bills your Serper account
  for its searches (one credit per page of 10 results), so what you pay can
  differ from the estimate the app shows before a check.
