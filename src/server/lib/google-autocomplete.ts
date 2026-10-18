import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { getIsoCountryCode } from "@/shared/keyword-locations";

// Free keyword ideas from Google's search autocomplete, for self-hosters
// without a working DataForSEO account. Autocomplete returns phrases people
// type, not metrics: rows built from it have no volume, CPC, difficulty, or
// intent. See docs/maintainers/specs/0024-autocomplete-keyword-ideas.md.

const AUTOCOMPLETE_URL = "https://suggestqueries.google.com/complete/search";
const REQUEST_TIMEOUT_MS = 10_000;
// Small batches keep a search to a handful of requests at a time, well clear
// of the rate limit Google applies to bursts.
const CONCURRENCY = 4;

const LATIN_LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const ARABIC_LETTERS = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي".split("");

// [query, suggestions, ...metadata]
const responseSchema = z
  .tuple([z.string(), z.array(z.string())])
  .rest(z.unknown());

async function fetchSuggestions(
  query: string,
  country: string,
  language: string,
): Promise<string[]> {
  const url = new URL(AUTOCOMPLETE_URL);
  url.search = new URLSearchParams({
    client: "firefox",
    q: query,
    gl: country,
    hl: language,
    ie: "utf-8",
    oe: "utf-8",
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("google-autocomplete request failed:", error);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Google autocomplete request failed",
      { provider: "google_autocomplete" },
    );
  }
  if (!response.ok) {
    throw new AppError(
      response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
      `Google autocomplete HTTP ${response.status}`,
      { provider: "google_autocomplete" },
    );
  }
  const [, suggestions] = responseSchema.parse(await response.json());
  return suggestions;
}

/**
 * The seed's own suggestions first (Google orders them by popularity), then
 * "seed a", "seed b", ... in the market language's alphabet until the limit
 * is reached. Only the seed request must succeed; a failed letter is skipped.
 */
export async function fetchAutocompleteKeywordIdeas(input: {
  seedKeyword: string;
  locationCode: number;
  languageCode: string;
  resultLimit: number;
}): Promise<string[]> {
  const country = getIsoCountryCode(input.locationCode);
  const language = input.languageCode.toLowerCase();
  const seed = input.seedKeyword.trim();
  const ideas = new Set<string>([seed.toLowerCase()]);
  const add = (suggestions: string[]) => {
    for (const suggestion of suggestions) {
      if (ideas.size >= input.resultLimit) return;
      const keyword = suggestion.trim().toLowerCase();
      if (keyword) ideas.add(keyword);
    }
  };

  add(await fetchSuggestions(seed, country, language));
  const letters = language === "ar" ? ARABIC_LETTERS : LATIN_LETTERS;
  for (
    let i = 0;
    i < letters.length && ideas.size < input.resultLimit;
    i += CONCURRENCY
  ) {
    const batch = letters.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((letter) =>
        fetchSuggestions(`${seed} ${letter}`, country, language),
      ),
    );
    for (const result of results) {
      if (result.status === "fulfilled") add(result.value);
    }
  }
  return [...ideas];
}
