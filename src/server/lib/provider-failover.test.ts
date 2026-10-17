import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { runWithFailover } from "@/server/lib/provider-failover";

describe("runWithFailover", () => {
  it("falls over on a provider failure, then tries that provider last", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dataforseo = vi
      .fn()
      .mockRejectedValue(new AppError("UPSTREAM_UNAVAILABLE"));
    const serper = vi.fn().mockResolvedValue("from serper");
    const attempts = [
      { provider: "dataforseo" as const, run: dataforseo },
      { provider: "serper" as const, run: serper },
    ];

    await expect(runWithFailover("test", attempts)).resolves.toBe(
      "from serper",
    );
    // DataForSEO is cooling down, so the next call skips straight to Serper.
    await expect(runWithFailover("test", attempts)).resolves.toBe(
      "from serper",
    );
    expect(dataforseo).toHaveBeenCalledTimes(1);
    expect(serper).toHaveBeenCalledTimes(2);
  });

  it("rethrows errors every provider would hit without trying the next", async () => {
    const fallback = vi.fn();

    await expect(
      runWithFailover("test", [
        {
          provider: "keywords_everywhere",
          run: () => Promise.reject(new AppError("VALIDATION_ERROR")),
        },
        { provider: "serper", run: fallback },
      ]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fallback).not.toHaveBeenCalled();
  });
});
