import { beforeEach, expect, it, vi } from "vitest";
import { research } from "./research";

const mocks = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  fetchRows: vi.fn(),
  upsertKeywordMetric: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      get: async (key: string) => {
        const value = mocks.cache.get(key);
        return value === undefined ? null : { text: async () => value };
      },
      put: async (key: string, value: string) => mocks.cache.set(key, value),
    },
  },
}));
vi.mock("./research-data", () => ({
  fetchResearchRowsBySource: mocks.fetchRows,
  fetchGoogleAdsResearchRows: mocks.fetchRows,
}));
vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: {
      upsertKeywordMetric: mocks.upsertKeywordMetric,
    },
  }),
);

const customer = {
  organizationId: "org_1",
  userId: "user_1",
  userEmail: "user@example.com",
};
const input = {
  projectId: "project_1",
  keywords: ["تسويق"],
  locationCode: 2818,
  languageCode: "ar",
  resultLimit: 150 as const,
  mode: "auto" as const,
  clickstream: false,
  groupKeywords: false,
};

// Answers "<seed>" and "<seed> <letter>" the way Google autocomplete does.
function autocomplete(answers: Record<string, string[] | number>) {
  return vi.fn(async (url: URL) => {
    const query = url.searchParams.get("q") ?? "";
    const answer = answers[query] ?? [];
    return typeof answer === "number"
      ? new Response("", { status: answer })
      : Response.json([query, answer, [], {}]);
  });
}

beforeEach(() => {
  mocks.cache.clear();
  vi.stubEnv("KEYWORD_IDEAS_PROVIDER", "google_autocomplete");
});

it("serves metric-less ideas from autocomplete without calling DataForSEO", async () => {
  const fetch = autocomplete({
    تسويق: ["تسويق الكتروني", "تسويق"],
    "تسويق ا": 429,
    "تسويق ب": ["تسويق بالعمولة", "تسويق بالعمولة امازون"],
  });
  vi.stubGlobal("fetch", fetch);

  const result = await research(input, customer);

  expect(result.source).toBe("autocomplete");
  expect(result.rows.map((row) => row.keyword)).toEqual([
    "تسويق",
    "تسويق الكتروني",
    "تسويق بالعمولة",
    "تسويق بالعمولة امازون",
  ]);
  expect(result.rows[0]).toMatchObject({
    searchVolume: null,
    keywordDifficulty: null,
  });
  expect(mocks.fetchRows).not.toHaveBeenCalled();
  expect(mocks.upsertKeywordMetric).not.toHaveBeenCalled();

  // Cached: a repeat search sends no requests.
  fetch.mockClear();
  await research(input, customer);
  expect(fetch).not.toHaveBeenCalled();
});
