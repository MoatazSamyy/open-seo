import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ kvList: vi.fn(), r2List: vi.fn() }));

vi.mock("cloudflare:workers", () => ({
  env: { KV: { list: mocks.kvList }, R2: { list: mocks.r2List } },
  waitUntil: vi.fn(),
}));

import { blobs, kv } from "@/platform/runtime";

describe("platform stores", () => {
  it("returns a KV cursor only while more pages follow", async () => {
    mocks.kvList
      .mockResolvedValueOnce({
        keys: [{ name: "a" }],
        list_complete: false,
        cursor: "next",
      })
      .mockResolvedValueOnce({ keys: [{ name: "b" }], list_complete: true });

    await expect(kv.list({ prefix: "p" })).resolves.toEqual({
      keys: ["a"],
      cursor: "next",
    });
    await expect(kv.list({ prefix: "p", cursor: "next" })).resolves.toEqual({
      keys: ["b"],
      cursor: undefined,
    });
  });

  it("lists blobs with their metadata and a cursor only while truncated", async () => {
    mocks.r2List.mockResolvedValueOnce({
      objects: [{ key: "x", customMetadata: { expiresAt: "t" } }, { key: "y" }],
      truncated: false,
    });

    await expect(blobs.list({ prefix: "p" })).resolves.toEqual({
      objects: [
        { key: "x", customMetadata: { expiresAt: "t" } },
        { key: "y", customMetadata: {} },
      ],
      cursor: undefined,
    });
    expect(mocks.r2List).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "p", include: ["customMetadata"] }),
    );
  });
});
