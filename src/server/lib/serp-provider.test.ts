import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async (name: string) => env.values[name]),
  getRequiredEnvValue: vi.fn(async (name: string) => env.values[name] ?? ""),
}));

import { fetchRoutedLiveSerp } from "@/server/lib/serp-provider";

// Failover puts a failed provider last for a minute (per module), so the
// failover tests run last in this file.

const DATAFORSEO_EMPTY_SERP = {
  status_code: 20000,
  tasks: [
    {
      status_code: 20000,
      path: ["v3", "serp", "google", "organic", "live", "advanced"],
      cost: 0.002,
      result: [{ items: [] }],
    },
  ],
};

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function stubFetch() {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    requestUrl(input).includes("serper.dev")
      ? Response.json({ organic: [], credits: 1 })
      : Response.json(DATAFORSEO_EMPTY_SERP),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calledHost(fetchMock: ReturnType<typeof stubFetch>) {
  return new URL(requestUrl(fetchMock.mock.calls[0][0])).host;
}

const query = { keyword: "seo", locationCode: 2840, languageCode: "en" };

describe("SERP provider routing", () => {
  beforeEach(() => {
    env.values = {
      DATAFORSEO_API_KEY: "dfs-key",
      SERP_PROVIDER: "serper",
      SERPER_API_KEY: "serper-key",
    };
  });

  it("sends desktop SERPs to Serper and mobile SERPs to DataForSEO", async () => {
    const desktopFetch = stubFetch();
    await fetchRoutedLiveSerp({ ...query, device: "desktop" });
    expect(calledHost(desktopFetch)).toBe("google.serper.dev");

    const mobileFetch = stubFetch();
    await fetchRoutedLiveSerp({ ...query, device: "mobile" });
    expect(calledHost(mobileFetch)).toBe("api.dataforseo.com");
  });

  it("falls back to DataForSEO when the Serper key is missing", async () => {
    delete env.values.SERPER_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = stubFetch();

    await fetchRoutedLiveSerp(query);

    expect(calledHost(fetchMock)).toBe("api.dataforseo.com");
  });

  it("falls over to Serper when DataForSEO is down", async () => {
    delete env.values.SERP_PROVIDER;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        requestUrl(input).includes("serper.dev")
          ? Response.json({
              organic: [{ title: "A", link: "https://a.com/" }],
              credits: 1,
            })
          : new Response("down", { status: 503 }),
      ),
    );

    const result = await fetchRoutedLiveSerp(query);

    expect(result.data).toEqual([
      expect.objectContaining({ domain: "a.com", rank_group: 1 }),
    ]);
  });

  it("charges a failed provider's billed pages on the answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let serperPage = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (!requestUrl(input).includes("serper.dev")) {
          return Response.json(DATAFORSEO_EMPTY_SERP);
        }
        serperPage += 1;
        return serperPage === 1
          ? Response.json({
              organic: [{ title: "A", link: "https://a.com/" }],
              credits: 1,
            })
          : new Response("down", { status: 503 });
      }),
    );

    // Serper bills page 1, fails on page 2, and DataForSEO answers.
    const result = await fetchRoutedLiveSerp({ ...query, depth: 20 });

    expect(result.billing.costUsd).toBeCloseTo(0.001 + 0.002);
  });
});
