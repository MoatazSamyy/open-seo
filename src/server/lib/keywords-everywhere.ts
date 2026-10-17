import { z } from "zod";
import type { DataforseoApiResponse } from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import {
  getOptionalEnvValue,
  getRequiredEnvValue,
} from "@/server/lib/runtime-env";
import type { ErrorCode } from "@/shared/error-codes";
import { getIsoCountryCode } from "@/shared/keyword-locations";

// Keywords Everywhere adapter for country-level keyword metrics (volume, CPC,
// competition, 12-month trend). It has no keyword difficulty, search intent,
// or sub-country targeting; see fetchKeywordMetricsForList for what stays on
// DataForSEO.

const API_BASE = "https://api.keywordseverywhere.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_LENGTH = 500;

/** get_keyword_data accepts up to 100 keywords per request. */
export const KEYWORDS_EVERYWHERE_BATCH_SIZE = 100;

/**
 * Rounded up from the smallest plan's per-credit price, so metering never
 * undercharges an operator on a bigger plan. One credit per keyword returned.
 */
const USD_PER_CREDIT = 0.001;

export function keywordsEverywhereUsd(keywordCount: number): number {
  return keywordCount * USD_PER_CREDIT;
}

const keywordItemSchema = z.object({
  keyword: z.string(),
  vol: z.number().nullable().optional(),
  cpc: z
    .object({ value: z.union([z.string(), z.number()]).nullable().optional() })
    .nullable()
    .optional(),
  competition: z.number().nullable().optional(),
  trend: z
    .array(z.object({ month: z.string(), year: z.number(), value: z.number() }))
    .default([]),
});

export type KeywordsEverywhereItem = z.infer<typeof keywordItemSchema>;

const keywordDataResponseSchema = z.object({
  data: z.array(keywordItemSchema).default([]),
  credits_consumed: z.number().optional(),
});

export async function fetchKeywordsEverywhereData(input: {
  keywords: string[];
  country: string;
}): Promise<DataforseoApiResponse<KeywordsEverywhereItem[]>> {
  if (input.keywords.length > KEYWORDS_EVERYWHERE_BATCH_SIZE) {
    throw new AppError(
      "INTERNAL_ERROR",
      `get_keyword_data accepts up to ${KEYWORDS_EVERYWHERE_BATCH_SIZE} keywords, got ${input.keywords.length}`,
    );
  }
  const response = await keywordsEverywhereFetch("/get_keyword_data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kw: input.keywords,
      country: input.country,
      currency: "usd",
      // Keyword Planner only, so volumes match the Google-Ads-derived numbers
      // DataForSEO shows; "cli" would blend in clickstream estimates.
      dataSource: "gkp",
    }),
  });
  const parsed = keywordDataResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Keywords Everywhere returned an unexpected response",
      { provider: "keywords_everywhere" },
    );
  }
  return {
    data: parsed.data.data,
    billing: {
      path: ["keywords_everywhere", "get_keyword_data"],
      costUsd: keywordsEverywhereUsd(
        parsed.data.credits_consumed ?? parsed.data.data.length,
      ),
    },
  };
}

const COUNTRIES_TTL_MS = 24 * 60 * 60 * 1000;

// Per-isolate cache of the supported country codes. The list changes rarely;
// failures are not cached, so a transient outage self-heals.
let countriesCache: { codes: Set<string>; fetchedAt: number } | null = null;

async function getSupportedCountries(): Promise<Set<string>> {
  if (
    countriesCache &&
    Date.now() - countriesCache.fetchedAt < COUNTRIES_TTL_MS
  ) {
    return countriesCache.codes;
  }
  const response = await keywordsEverywhereFetch("/countries", {
    method: "GET",
  });
  const parsed = z
    .record(z.string(), z.string())
    .safeParse(await response.json());
  if (!parsed.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Keywords Everywhere returned an unexpected country list",
      { provider: "keywords_everywhere" },
    );
  }
  // "" is Keywords Everywhere's global (no country) entry.
  const codes = new Set(Object.keys(parsed.data).filter(Boolean));
  countriesCache = { codes, fetchedAt: Date.now() };
  return codes;
}

/**
 * The Keywords Everywhere country to use for a location, or null when keyword
 * metrics for it should come from DataForSEO: the operator didn't pick
 * Keywords Everywhere, its key is missing, it doesn't cover the country, or
 * its country list can't be read.
 */
export async function resolveKeywordsEverywhereCountry(
  locationCode: number,
): Promise<string | null> {
  const provider = (await getOptionalEnvValue("KEYWORD_METRICS_PROVIDER"))
    ?.trim()
    .toLowerCase();
  if (!provider || provider === "dataforseo") return null;
  if (provider !== "keywords_everywhere") {
    console.warn(
      `keyword-metrics: unknown KEYWORD_METRICS_PROVIDER "${provider}"; using DataForSEO`,
    );
    return null;
  }
  if (!(await getOptionalEnvValue("KEYWORDS_EVERYWHERE_API_KEY"))) {
    console.warn(
      "keyword-metrics: KEYWORD_METRICS_PROVIDER=keywords_everywhere but KEYWORDS_EVERYWHERE_API_KEY is not set; using DataForSEO",
    );
    return null;
  }

  const iso = getIsoCountryCode(locationCode);
  // Keywords Everywhere uses "uk" for the United Kingdom, not ISO's "gb".
  const country = iso === "gb" ? "uk" : iso;
  try {
    return (await getSupportedCountries()).has(country) ? country : null;
  } catch (error) {
    console.warn(
      "keyword-metrics: Keywords Everywhere country list unavailable; using DataForSEO",
      error,
    );
    return null;
  }
}

async function keywordsEverywhereFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const apiKey = await getRequiredEnvValue("KEYWORDS_EVERYWHERE_API_KEY");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("Accept", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        `Keywords Everywhere request timed out on ${path}`,
        { provider: "keywords_everywhere" },
      );
    }
    throw error;
  }
  if (response.ok) return response;

  const code: ErrorCode =
    response.status >= 500
      ? "UPSTREAM_UNAVAILABLE"
      : response.status === 429
        ? "RATE_LIMITED"
        : "INTERNAL_ERROR";
  const hint =
    response.status === 401
      ? " (check KEYWORDS_EVERYWHERE_API_KEY)"
      : response.status === 402
        ? " (subscription or credits ran out)"
        : "";
  throw new AppError(
    code,
    `Keywords Everywhere HTTP ${response.status} on ${path}${hint}`,
    {
      provider: "keywords_everywhere",
      providerStatus: String(response.status),
      responseBody: (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH),
    },
  );
}
