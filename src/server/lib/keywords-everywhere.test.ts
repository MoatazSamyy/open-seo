import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(),
  getRequiredEnvValue: vi.fn(async () => "test-ke-key"),
}));

import { fetchKeywordsEverywhereData } from "@/server/lib/keywords-everywhere";

describe("Keywords Everywhere keyword data", () => {
  it("requests Keyword Planner data and bills the credits consumed", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ keyword: "best crm", vol: 1000, trend: [] }],
        credits: 99,
        credits_consumed: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchKeywordsEverywhereData({
      keywords: ["best crm"],
      country: "us",
    });

    const init = fetchMock.mock.calls[0][1];
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-ke-key",
    );
    if (typeof init?.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(init.body)).toEqual({
      kw: ["best crm"],
      country: "us",
      currency: "usd",
      dataSource: "gkp",
    });
    expect(result.billing).toEqual({
      path: ["keywords_everywhere", "get_keyword_data"],
      costUsd: 0.001,
    });
  });

  it("names the API key when Keywords Everywhere rejects it", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { message: "401 Missing Or Invalid API Key" },
            { status: 401 },
          ),
        ),
    );

    await expect(
      fetchKeywordsEverywhereData({ keywords: ["best crm"], country: "us" }),
    ).rejects.toThrow("check KEYWORDS_EVERYWHERE_API_KEY");
  });
});
