import { z } from "zod";
import {
  buildRankCheckResult,
  clampSerpDepth,
  SERP_ANALYSIS_DEPTH,
  type fetchLiveSerp,
  type fetchRankCheckSerp,
  type RankCheckResult,
  type SerpLiveItem,
} from "@/server/lib/dataforseo/serp";
import {
  DataforseoChargedTaskError,
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import { getRequiredEnvValue } from "@/server/lib/runtime-env";
import type { ErrorCode } from "@/shared/error-codes";
import {
  formatLocationLabel,
  getIsoCountryCode,
} from "@/shared/keyword-locations";

// Serper.dev adapter for desktop organic Google SERPs. Results are mapped to
// DataForSEO's SerpLiveItem shape so callers don't know which provider
// answered; see docs/maintainers/specs/0016-serp-provider-routing.md.

const SERPER_SEARCH_URL = "https://google.serper.dev/search";
const SERPER_REQUEST_TIMEOUT_MS = 30_000;
const SERPER_RESULTS_PER_PAGE = 10;
const MAX_ERROR_BODY_LENGTH = 500;

/**
 * Serper's highest public per-credit price (its smallest credit pack). Metering
 * at this rate never undercharges an operator on a cheaper pack.
 */
const SERPER_USD_PER_CREDIT = 0.001;

/** Serper bills one credit per page of 10 results. */
export function serperUsd(depth: number): number {
  return (
    Math.ceil(clampSerpDepth(depth) / SERPER_RESULTS_PER_PAGE) *
    SERPER_USD_PER_CREDIT
  );
}

const serperResponseSchema = z.object({
  organic: z
    .array(
      z
        .object({
          title: z.string().nullable().optional(),
          link: z.string(),
          snippet: z.string().nullable().optional(),
        })
        .passthrough(),
    )
    .default([]),
  answerBox: z.unknown().optional(),
  knowledgeGraph: z.unknown().optional(),
  topStories: z.array(z.unknown()).optional(),
  peopleAlsoAsk: z.array(z.unknown()).optional(),
  places: z.array(z.unknown()).optional(),
  images: z.array(z.unknown()).optional(),
  videos: z.array(z.unknown()).optional(),
  relatedSearches: z.array(z.unknown()).optional(),
  credits: z.number().optional(),
});

type SerperResponse = z.infer<typeof serperResponseSchema>;

// Serper response sections that mark a SERP feature, with DataForSEO's item
// type for each, so rank tracking's serpFeatures list reads the same.
const SERP_FEATURE_TYPES = [
  ["answerBox", "featured_snippet"],
  ["knowledgeGraph", "knowledge_graph"],
  ["topStories", "top_stories"],
  ["peopleAlsoAsk", "people_also_ask"],
  ["places", "local_pack"],
  ["images", "images"],
  ["videos", "video"],
  ["relatedSearches", "related_searches"],
] as const satisfies ReadonlyArray<readonly [keyof SerperResponse, string]>;

type SerpQuery = {
  keyword: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
};

export async function fetchSerperLiveSerp(
  input: Parameters<typeof fetchLiveSerp>[0],
): Promise<DataforseoApiResponse<SerpLiveItem[]>> {
  return crawlSerperPages(
    input,
    input.depth ?? SERP_ANALYSIS_DEPTH,
    () => false,
  );
}

/**
 * Stops after the page where the target shows up as an organic result, like
 * DataForSEO's stop_crawl_on_match, so a page-1 ranking costs one credit.
 */
export async function fetchSerperRankCheck(
  input: Parameters<typeof fetchRankCheckSerp>[0],
): Promise<DataforseoApiResponse<RankCheckResult>> {
  const response = await crawlSerperPages(
    input,
    input.depth,
    (items) => buildRankCheckResult(input, items).position !== null,
  );
  return {
    data: buildRankCheckResult(input, response.data),
    billing: response.billing,
  };
}

/**
 * Fetches pages of 10 one at a time until `depth` is covered, a page adds no
 * new organic result, or `isDone` says to stop. Organic positions are counted
 * here across pages; rank_absolute stays null because Serper doesn't say where
 * SERP features sit between organic results.
 */
async function crawlSerperPages(
  input: SerpQuery,
  depth: number,
  isDone: (items: SerpLiveItem[]) => boolean,
): Promise<DataforseoApiResponse<SerpLiveItem[]>> {
  const pages = Math.ceil(clampSerpDepth(depth) / SERPER_RESULTS_PER_PAGE);
  const billing: DataforseoApiCallCost = {
    path: ["serper", "search"],
    costUsd: 0,
  };
  const items: SerpLiveItem[] = [];
  const seenLinks = new Set<string>();
  let organicCount = 0;

  for (let page = 1; page <= pages; page++) {
    let response: SerperResponse;
    try {
      response = await postSerperSearch(input, page);
    } catch (error) {
      if (billing.costUsd === 0) throw error;
      // Earlier pages were billed, so the meter must charge them before the
      // failure surfaces. A partial list isn't returned: callers cache it as
      // a snapshot of the full requested depth.
      throw new DataforseoChargedTaskError(
        error instanceof Error ? error.message : String(error),
        billing,
        false,
        error instanceof AppError ? error.code : "UPSTREAM_UNAVAILABLE",
      );
    }
    billing.costUsd += (response.credits ?? 1) * SERPER_USD_PER_CREDIT;

    if (page === 1) items.push(...mapSerpFeatures(response));

    let added = 0;
    for (const organic of response.organic) {
      const domain = hostnameOf(organic.link);
      if (!domain || seenLinks.has(organic.link)) continue;
      seenLinks.add(organic.link);
      organicCount += 1;
      added += 1;
      items.push({
        type: "organic",
        rank_group: organicCount,
        rank_absolute: null,
        domain,
        title: organic.title ?? null,
        url: organic.link,
        description: organic.snippet ?? null,
      });
    }
    if (added === 0 || isDone(items)) break;
  }

  return { data: items, billing };
}

function mapSerpFeatures(response: SerperResponse): SerpLiveItem[] {
  return SERP_FEATURE_TYPES.filter(([key]) => {
    const value = response[key];
    return Array.isArray(value) ? value.length > 0 : value != null;
  }).map(([, type]) => ({ type, rank_group: null, rank_absolute: null }));
}

function hostnameOf(link: string): string | null {
  try {
    return new URL(link).hostname || null;
  } catch {
    return null;
  }
}

async function postSerperSearch(
  input: SerpQuery,
  page: number,
): Promise<SerperResponse> {
  const apiKey = await getRequiredEnvValue("SERPER_API_KEY");
  let response: Response;
  try {
    response = await fetch(SERPER_SEARCH_URL, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        q: input.keyword,
        gl: getIsoCountryCode(input.locationCode),
        hl: input.languageCode.toLowerCase(),
        // DataForSEO's canonical names ("Enid,Oklahoma,United States") are
        // Google's geotarget names; Serper wants them comma-space separated.
        ...(input.locationName
          ? { location: formatLocationLabel(input.locationName) }
          : {}),
        num: SERPER_RESULTS_PER_PAGE,
        page,
      }),
      signal: AbortSignal.timeout(SERPER_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new AppError("UPSTREAM_UNAVAILABLE", "Serper request timed out", {
        provider: "serper",
      });
    }
    throw error;
  }

  if (!response.ok) {
    const code: ErrorCode =
      response.status >= 500
        ? "UPSTREAM_UNAVAILABLE"
        : response.status === 429
          ? "RATE_LIMITED"
          : "INTERNAL_ERROR";
    const hint =
      response.status === 401 || response.status === 403
        ? " (check SERPER_API_KEY)"
        : "";
    throw new AppError(code, `Serper HTTP ${response.status}${hint}`, {
      provider: "serper",
      providerStatus: String(response.status),
      responseBody: (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH),
    });
  }

  const parsed = serperResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Serper returned an unexpected response",
      { provider: "serper" },
    );
  }
  return parsed.data;
}
