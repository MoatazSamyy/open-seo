import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-serper-key"),
}));

import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { fetchSerperLiveSerp, fetchSerperRankCheck } from "@/server/lib/serper";

function organic(links: string[]) {
  return links.map((link) => ({ title: `Title ${link}`, link }));
}

describe("Serper SERPs", () => {
  it("counts organic positions across pages and bills each page", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          organic: organic(["https://a.com/", "https://www.b.com/x"]),
          peopleAlsoAsk: [{ question: "q" }],
          relatedSearches: [],
          credits: 1,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          // Google repeats a result across pages; it keeps its first position.
          organic: organic(["https://www.b.com/x", "https://c.com/"]),
          credits: 1,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSerperLiveSerp({
      keyword: "seo tools",
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
    });

    expect(result.data).toEqual([
      { type: "people_also_ask", rank_group: null, rank_absolute: null },
      expect.objectContaining({ rank_group: 1, domain: "a.com" }),
      expect.objectContaining({ rank_group: 2, domain: "www.b.com" }),
      expect.objectContaining({ rank_group: 3, domain: "c.com" }),
    ]);
    expect(result.billing).toEqual({
      path: ["serper", "search"],
      costUsd: 0.002,
    });
  });

  it("stops a rank check after the page where the target ranks", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        organic: organic(["https://other.com/", "https://blog.target.com/p"]),
        credits: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSerperRankCheck({
      keyword: "seo tools",
      keywordId: "kw-1",
      locationCode: 2840,
      languageCode: "en",
      locationName: "Enid,Oklahoma,United States",
      device: "desktop",
      targetDomain: "target.com",
      depth: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = fetchMock.mock.calls[0][1]?.body;
    if (typeof body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(body)).toMatchObject({
      gl: "us",
      location: "Enid, Oklahoma, United States",
    });
    expect(result.data).toMatchObject({
      position: 2,
      url: "https://blog.target.com/p",
    });
    expect(result.billing.costUsd).toBe(0.001);
  });

  it("charges pages already fetched when a later page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ organic: organic(["https://a.com/"]), credits: 1 }),
        )
        .mockResolvedValueOnce(new Response("busy", { status: 503 })),
    );

    const error: unknown = await fetchSerperLiveSerp({
      keyword: "seo tools",
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DataforseoChargedTaskError);
    expect(error).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      billing: { costUsd: 0.001 },
    });
  });
});
