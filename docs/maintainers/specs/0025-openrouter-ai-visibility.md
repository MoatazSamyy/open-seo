# 0025 — AI visibility answers through OpenRouter

## Status

Proposed (October 2026), fork follow-up to milestone 1. Self-hosted only.

## Context

Prompt Tracking asks each tracked prompt to each selected engine and records
whether the answer mentions or cites the project and its competitors. Every
answer comes from DataForSEO: its LLM Scraper for ChatGPT, Gemini, and Google
AI Overviews, and its LLM Responses API for Claude and Perplexity. A
self-hoster who can't use DataForSEO (an account that can't be verified, for
example) can't track anything.

OpenRouter sells access to the same model families with a web search plugin
that returns the cited URLs as annotations. The AI SDK provider already maps
those to URL sources. AI visibility setup already needs an OpenRouter key for
its website research.

## Decision

1. **An opt-in setting.** `AI_VISIBILITY_PROVIDER=openrouter` sends every
   answer of a tracking run to OpenRouter. It is ignored in hosted mode: these
   calls bypass usage-credit metering.
2. **Every engine is a model call.** The run plan puts all answers in model
   batches, so the existing workflow collects them without the scraper's
   post-and-poll steps. Each answer is saved as it arrives, the same as
   Claude and Perplexity answers today.
3. **One small model per engine.** ChatGPT, Claude, Gemini, and Perplexity
   map to a current low-cost model of the same family, with OpenRouter's web
   search on. The prompt goes in as the user's message, with only the
   market's country as context. Google AI Overviews has no model; its answers
   fail with copy that says the engine isn't available.
4. **The same evidence pipeline.** Answer text and cited URLs go through the
   parser and brand matching that DataForSEO answers use, so results,
   sources, and trends need no changes.
5. **Setup tolerates an unusable search account.** Competitor research in
   setup now uses the routed SERP (Serper when configured), and a search
   provider that rejects the account is treated like an outage: research
   finishes without competitors for the user to add, instead of failing.

## Alternatives considered

- **Failover from DataForSEO to OpenRouter.** Rejected: the answers differ
  from the consumer apps DataForSEO scrapes, so silently mixing them would
  distort trends.
- **Calling each vendor's API directly.** Four keys and four citation formats
  instead of one.

## Consequences

- Prompt Tracking works with only an OpenRouter key.
- Answers come from API models with web search, not the consumer apps, so
  they can differ from what a person sees in ChatGPT or Gemini.
- Cost estimates in the app still use DataForSEO prices; OpenRouter bills its
  own rates.
- Prompt Research and Prompt Explorer still need DataForSEO.
