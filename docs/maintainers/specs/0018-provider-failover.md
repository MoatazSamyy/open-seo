# 0018 — Provider failover

## Status

Proposed (October 2026), fork milestone 1d.

## Context

Specs 0016 and 0017 let an operator serve desktop organic SERPs from Serper
and country-level keyword metrics from Keywords Everywhere. Each request
still went to exactly one provider, so an outage at that provider failed the
request even when the other one was configured and could have answered.

## Decision

1. **Configured keys are the opt-in.** A request falls over to the other
   provider whenever that provider's key is set, whichever one is primary.
   `SERP_PROVIDER` and `KEYWORD_METRICS_PROVIDER` choose the order; DataForSEO
   stays first by default.
2. **Only provider-side failures fall over.** Upstream errors (5xx,
   timeouts), rate limits, and DataForSEO auth failures move to the next
   provider. Errors any provider would hit (invalid input, the customer's own
   credits) are rethrown at once.
3. **One retry, no loops.** Each request tries each provider at most once, in
   order, and surfaces the last provider's error if both fail.
4. **A failed provider goes last for a minute.** The failure is remembered
   per isolate, so during a hard outage requests start on the healthy
   provider instead of paying a failed call first. After the minute, the
   configured order returns.
5. **Charged failures are still billed.** A failed attempt can have been
   charged (for example, Serper billed page 1 before page 2 failed). Its cost
   is added to the answer's billing, or carried on the final error, so the
   meter charges what the providers charged.
6. **Same coverage rules as routing.** SERP failover is desktop only, and
   metrics failover is country-level only and limited to countries Keywords
   Everywhere lists. Everything else has a single provider.
7. **Failovers are logged.** Each failover and which provider answered is a
   `provider-failover:` warning, so the rate is visible in logs.

## Alternatives considered

- **Shared health state (KV or a Durable Object).** Rejected for now: a
  per-isolate minute is enough to stop paying failed calls during an outage,
  and it adds no storage writes to the hot path.
- **Retrying the same provider first.** DataForSEO's client already retries
  idempotent 5xx reads, so another same-provider retry would only add
  latency.
- **Backlinks failover.** Not possible yet: neither Keywords Everywhere (link
  lists only, no totals, filters, or history) nor Moz (totals only) can serve
  the backlinks pages as they are.

## Consequences

- With both keys set, SERP analysis, `get_serp_results`, live rank checks,
  `get_keyword_metrics`, and metric refreshes keep working through a
  single-provider outage.
- Rows served by Keywords Everywhere during a failover have no keyword
  difficulty or intent until the next refresh on DataForSEO.
- A metrics list over 700 keywords that fails partway through DataForSEO's
  batches is fetched again from the start on Keywords Everywhere, so the
  batches DataForSEO already answered are paid twice.
