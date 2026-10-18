# 0024 — Keyword ideas from Google autocomplete

## Status

Proposed (October 2026), fork follow-up to milestone 1.

## Context

Keyword research gets its ideas, and every metric on them, from DataForSEO
(Labs suggestions, ideas, and related keywords, or Google Ads for countries
Labs doesn't cover). Some self-hosters can't use DataForSEO: its accounts
must be verified, and in some countries the only verification method isn't
available. For them the keyword research page is unusable, even though
finding candidate keywords is useful without volumes.

Google's search autocomplete is free, needs no account, and is
country- and language-aware. It returns up to ten phrases per query, ordered
by popularity, and nothing else.

## Decision

1. **An opt-in setting.** `KEYWORD_IDEAS_PROVIDER=google_autocomplete` serves
   keyword research from autocomplete. Without it nothing changes. It is not a
   failover target: silently swapping DataForSEO rows for metric-less ones
   would look like missing data rather than a different source.
2. **Expansion by alphabet.** One query for the seed, then "seed a",
   "seed b", ... in the market language's alphabet (Arabic letters for
   Arabic, Latin otherwise), a few at a time, until the result limit is
   reached. Only the seed query must succeed; a failed letter is skipped.
3. **Ideas only.** Rows have no volume, trend, CPC, competition, difficulty,
   or intent, and report `source: "autocomplete"`. They aren't written to
   stored keyword metrics, so they never overwrite real numbers, and a city
   or region request returns the country's ideas.
4. **Cached like other research.** Results are cached per organization, seed,
   market, and limit for the usual research TTL, in their own cache
   namespace so switching providers never serves the other's rows.

## Alternatives considered

- **Google Ads Keyword Planner API.** Real volumes and free, but it needs a
  manually approved developer token, and accounts without ad spend get
  bucketed ranges.
- **Bing Webmaster Tools keyword API.** Free volumes, but Bing's, and it
  needs a verified site in Bing Webmaster Tools. A possible later metrics
  source rather than an ideas source.
- **Serper's autocomplete endpoint.** The same data, billed per request.

## Consequences

- Keyword research works with no DataForSEO account, for idea discovery.
- Sorting and filtering by metrics does nothing on these rows; volumes for
  chosen keywords still need a metrics provider or Search Console.
- The endpoint is unofficial and may rate-limit or change without notice.
