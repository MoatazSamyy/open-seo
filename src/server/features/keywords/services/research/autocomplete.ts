import { z } from "zod";
import { fetchAutocompleteKeywordIdeas } from "@/server/lib/google-autocomplete";
import {
  CACHE_TTL,
  buildCacheKey,
  getCached,
  setCached,
} from "@/server/lib/r2-cache";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { ResolvedResearchKeywordsInput } from "@/types/schemas/keywords";
import type { EnrichedKeyword } from "./helpers";

export async function usesAutocompleteKeywordIdeas(): Promise<boolean> {
  return (
    (await getOptionalEnvValue("KEYWORD_IDEAS_PROVIDER")) ===
    "google_autocomplete"
  );
}

/**
 * Keyword research from Google autocomplete only: ideas with every metric
 * empty. Nothing is persisted, so stored metrics for saved keywords stay as
 * they are, and a city or region adds nothing (there is no volume to localize).
 */
export async function researchWithAutocomplete(
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  billingCustomer: BillingCustomerContext,
) {
  const cacheKey = await buildCacheKey("kw:research:autocomplete", {
    organizationId: billingCustomer.organizationId,
    keyword: seedKeyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    resultLimit: input.resultLimit,
  });
  const cached = z.array(z.string()).safeParse(await getCached(cacheKey));
  const keywords = cached.success
    ? cached.data
    : await fetchAutocompleteKeywordIdeas({
        seedKeyword,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        resultLimit: input.resultLimit,
      });
  if (!cached.success)
    await setCached(cacheKey, keywords, CACHE_TTL.researchResult);

  const rows: EnrichedKeyword[] = keywords.map((keyword) => ({
    keyword,
    searchVolume: null,
    trend: [],
    cpc: null,
    competition: null,
    keywordDifficulty: null,
    intent: "unknown",
  }));
  return { rows, source: "autocomplete" as const, usedFallback: false };
}
