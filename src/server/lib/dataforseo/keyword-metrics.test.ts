import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/server/lib/errors";
import { fetchKeywordMetricsForList } from "./keyword-metrics";

type Client = Parameters<typeof fetchKeywordMetricsForList>[0];

// Minimal fake client exposing only the endpoints the helper touches.
function fakeClient(overrides: {
  keywordOverview?: Client["labs"]["keywordOverview"];
  adsSearchVolume?: Client["keywords"]["adsSearchVolume"];
  keywordData?: Client["keywordsEverywhere"]["keywordData"];
}): Client {
  return {
    labs: { keywordOverview: overrides.keywordOverview ?? vi.fn() },
    keywords: { adsSearchVolume: overrides.adsSearchVolume ?? vi.fn() },
    keywordsEverywhere: { keywordData: overrides.keywordData ?? vi.fn() },
  };
}

describe("fetchKeywordMetricsForList", () => {
  it("normalizes Labs items and prefers clickstream-refined volume/trend", async () => {
    const keywordOverview = vi.fn().mockResolvedValue([
      {
        keyword: "best crm",
        keyword_info: {
          search_volume: 1000,
          cpc: 3.2,
          competition: 0.5,
          competition_level: "MEDIUM",
          monthly_searches: [{ year: 2026, month: 1, search_volume: 1000 }],
        },
        keyword_info_normalized_with_clickstream: {
          search_volume: 880,
          monthly_searches: [{ year: 2026, month: 1, search_volume: 880 }],
        },
        keyword_properties: { keyword_difficulty: 42 },
        search_intent_info: { main_intent: "commercial" },
      },
    ]);
    const client = fakeClient({ keywordOverview });

    const rows = await fetchKeywordMetricsForList(client, {
      keywords: ["best crm"],
      locationCode: 2840,
      languageCode: "en",
      includeClickstreamData: true,
      creditFeature: "keyword_research",
    });

    expect(keywordOverview).toHaveBeenCalledWith({
      keywords: ["best crm"],
      locationCode: 2840,
      languageCode: "en",
      includeClickstreamData: true,
      creditFeature: "keyword_research",
    });
    expect(rows).toEqual([
      {
        keyword: "best crm",
        searchVolume: 880,
        cpc: 3.2,
        competition: 0.5,
        competitionLevel: "MEDIUM",
        keywordDifficulty: 42,
        intent: "commercial",
        monthlySearches: [{ year: 2026, month: 1, searchVolume: 880 }],
      },
    ]);
  });

  it("routes Google Ads locations and scales competition_index to a 0-1 ratio", async () => {
    const adsSearchVolume = vi.fn().mockResolvedValue([
      {
        keyword: "hotel reykjavik",
        search_volume: 1300,
        cpc: 2.54,
        competition: "HIGH",
        competition_index: 42,
        monthly_searches: [{ year: 2026, month: 5, search_volume: 1300 }],
      },
      { keyword: undefined },
    ]);
    const client = fakeClient({ adsSearchVolume });

    const rows = await fetchKeywordMetricsForList(client, {
      keywords: ["hotel reykjavik"],
      locationCode: 2352,
      languageCode: "is",
      creditFeature: "rank_tracking",
    });

    expect(adsSearchVolume).toHaveBeenCalledWith({
      keywords: ["hotel reykjavik"],
      locationCode: 2352,
      languageCode: "is",
      creditFeature: "rank_tracking",
    });
    // Item without a keyword is dropped; Ads carries no KD/intent.
    expect(rows).toEqual([
      {
        keyword: "hotel reykjavik",
        searchVolume: 1300,
        cpc: 2.54,
        competition: 0.42,
        competitionLevel: "HIGH",
        keywordDifficulty: null,
        intent: null,
        monthlySearches: [{ year: 2026, month: 5, searchVolume: 1300 }],
      },
    ]);
  });

  it("skips keywords Google Ads rejects instead of failing the batch", async () => {
    const adsSearchVolume = vi.fn().mockResolvedValue([]);

    const rows = await fetchKeywordMetricsForList(
      fakeClient({ adsSearchVolume }),
      {
        keywords: ["hotel reykjavik", "hotel (cheap)", "best hotel?"],
        locationCode: 2352,
        languageCode: "is",
        creditFeature: "rank_tracking",
      },
    );

    expect(adsSearchVolume).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: ["hotel reykjavik"] }),
    );
    // Rejected keywords get empty metrics, so a refresh clears stale values.
    expect(rows).toEqual([
      expect.objectContaining({ keyword: "hotel (cheap)", searchVolume: null }),
      expect.objectContaining({ keyword: "best hotel?", searchVolume: null }),
    ]);
  });

  it("batches keyword lists above the per-call cap", async () => {
    const keywordOverview = vi
      .fn()
      .mockImplementation(({ keywords }: { keywords: string[] }) =>
        Promise.resolve(
          keywords.map((keyword) => ({ keyword, keyword_info: {} })),
        ),
      );
    const client = fakeClient({ keywordOverview });
    const keywords = Array.from({ length: 1500 }, (_, i) => `kw-${i}`);

    const rows = await fetchKeywordMetricsForList(client, {
      keywords,
      locationCode: 2840,
      languageCode: "en",
      creditFeature: "keyword_research",
    });

    expect(keywordOverview).toHaveBeenCalledTimes(3); // 700 + 700 + 100
    expect(rows).toHaveLength(1500);
  });

  it("merges city-scoped Ads volume with national Labs KD for local requests", async () => {
    const adsSearchVolume = vi.fn().mockResolvedValue([
      {
        keyword: "plumber near me",
        search_volume: 260,
        cpc: 7.54,
        competition: "MEDIUM",
        competition_index: 55,
        monthly_searches: [],
      },
      // "emergency plumber near me" collapsed away by Google Ads normalization.
    ]);
    const keywordOverview = vi.fn().mockResolvedValue([
      {
        keyword: "plumber near me",
        keyword_info: { search_volume: 135000, cpc: 11.29 },
        keyword_properties: { keyword_difficulty: 76 },
        search_intent_info: { main_intent: "transactional" },
      },
      {
        keyword: "emergency plumber near me",
        keyword_info: { search_volume: 135000, cpc: 5.93 },
        keyword_properties: { keyword_difficulty: 17 },
        search_intent_info: { main_intent: "transactional" },
      },
    ]);
    const client = fakeClient({ adsSearchVolume, keywordOverview });

    const rows = await fetchKeywordMetricsForList(client, {
      keywords: [
        "plumber near me",
        "emergency plumber near me",
        "plumber (24/7)",
      ],
      locationCode: 2840,
      languageCode: "en",
      locationName: "Springfield,Illinois,United States",
      creditFeature: "rank_tracking",
    });

    expect(adsSearchVolume).toHaveBeenCalledWith(
      expect.objectContaining({
        locationName: "Springfield,Illinois,United States",
      }),
    );
    // Local volume/CPC from Ads, national KD/intent from Labs.
    expect(rows[0]).toMatchObject({
      keyword: "plumber near me",
      searchVolume: 260,
      cpc: 7.54,
      keywordDifficulty: 76,
      intent: "transactional",
    });
    // Keyword Ads dropped: KD/intent survive, but the national volume/CPC
    // must NOT leak into a local request.
    expect(rows[1]).toMatchObject({
      keyword: "emergency plumber near me",
      searchVolume: null,
      cpc: null,
      keywordDifficulty: 17,
      intent: "transactional",
    });
    // Neither source returned it: an empty row still clears stale metrics.
    expect(rows[2]).toMatchObject({
      keyword: "plumber (24/7)",
      searchVolume: null,
      keywordDifficulty: null,
    });
  });
});

describe("fetchKeywordMetricsForList with Keywords Everywhere", () => {
  beforeEach(() => {
    vi.stubEnv("KEYWORD_METRICS_PROVIDER", "keywords_everywhere");
    vi.stubEnv("KEYWORDS_EVERYWHERE_API_KEY", "ke-key");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ "": "Global", us: "United States" }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves country-level metrics from Keywords Everywhere", async () => {
    const keywordData = vi.fn().mockResolvedValue([
      {
        keyword: "best crm",
        vol: 1000,
        cpc: { currency: "$", value: "3.20" },
        competition: 0.5,
        trend: [{ month: "May", year: 2026, value: 900 }],
      },
    ]);
    const keywordOverview = vi.fn();
    const client = fakeClient({ keywordData, keywordOverview });

    const rows = await fetchKeywordMetricsForList(client, {
      keywords: ["best crm", "crm for dentists"],
      locationCode: 2840,
      languageCode: "en",
      creditFeature: "keyword_research",
    });

    expect(keywordOverview).not.toHaveBeenCalled();
    expect(keywordData).toHaveBeenCalledWith({
      keywords: ["best crm", "crm for dentists"],
      country: "us",
      creditFeature: "keyword_research",
    });
    expect(rows).toEqual([
      {
        keyword: "best crm",
        searchVolume: 1000,
        cpc: 3.2,
        competition: 0.5,
        competitionLevel: null,
        keywordDifficulty: null,
        intent: null,
        monthlySearches: [{ year: 2026, month: 5, searchVolume: 900 }],
      },
      expect.objectContaining({
        keyword: "crm for dentists",
        searchVolume: null,
      }),
    ]);
  });

  it("keeps local requests and uncovered countries on DataForSEO", async () => {
    const keywordData = vi.fn();
    const keywordOverview = vi.fn().mockResolvedValue([]);
    const adsSearchVolume = vi.fn().mockResolvedValue([]);
    const client = fakeClient({
      keywordData,
      keywordOverview,
      adsSearchVolume,
    });

    // Germany isn't in the stubbed country list.
    await fetchKeywordMetricsForList(client, {
      keywords: ["beste crm"],
      locationCode: 2276,
      languageCode: "de",
      creditFeature: "keyword_research",
    });
    await fetchKeywordMetricsForList(client, {
      keywords: ["best crm"],
      locationCode: 2840,
      languageCode: "en",
      locationName: "Austin,Texas,United States",
      creditFeature: "keyword_research",
    });

    expect(keywordData).not.toHaveBeenCalled();
    expect(keywordOverview).toHaveBeenCalledTimes(2);
  });

  // Last in the file: the failover puts DataForSEO last for a minute.
  it("falls over to Keywords Everywhere when DataForSEO is down", async () => {
    vi.stubEnv("KEYWORD_METRICS_PROVIDER", "");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const keywordOverview = vi
      .fn()
      .mockRejectedValue(new AppError("UPSTREAM_UNAVAILABLE"));
    const keywordData = vi
      .fn()
      .mockResolvedValue([{ keyword: "best crm", vol: 1000, trend: [] }]);
    const client = fakeClient({ keywordOverview, keywordData });

    const rows = await fetchKeywordMetricsForList(client, {
      keywords: ["best crm"],
      locationCode: 2840,
      languageCode: "en",
      creditFeature: "keyword_research",
    });

    expect(keywordOverview).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      expect.objectContaining({ keyword: "best crm", searchVolume: 1000 }),
    ]);
  });
});
