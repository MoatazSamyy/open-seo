import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobs } from "@/platform/runtime.node";

let blobDir: string;

beforeEach(async () => {
  blobDir = await mkdtemp(path.join(tmpdir(), "openseo-blobs-"));
  vi.stubEnv("BLOB_DIR", blobDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(blobDir, { recursive: true, force: true });
});

describe("Node blob store", () => {
  it("stores blobs with metadata and pages through a prefix", async () => {
    await blobs.put("exports/p1/a", "first", {
      customMetadata: { expiresAt: "t" },
    });
    await blobs.put("exports/p1/b", "second");
    await blobs.put("exports/p2/c", "other project");

    const object = await blobs.get("exports/p1/a");
    expect(await object?.text()).toBe("first");
    expect(object?.customMetadata).toEqual({ expiresAt: "t" });

    const first = await blobs.list({ prefix: "exports/p1/", limit: 1 });
    expect(first).toEqual({
      objects: [{ key: "exports/p1/a", customMetadata: { expiresAt: "t" } }],
      cursor: "exports/p1/a",
    });
    const second = await blobs.list({
      prefix: "exports/p1/",
      cursor: first.cursor,
      limit: 1,
    });
    expect(second).toEqual({
      objects: [{ key: "exports/p1/b", customMetadata: {} }],
      cursor: undefined,
    });

    await blobs.delete(["exports/p1/a", "exports/p1/b"]);
    expect(await blobs.get("exports/p1/a")).toBeNull();
    expect((await blobs.list({ prefix: "exports/" })).objects).toEqual([
      { key: "exports/p2/c", customMetadata: {} },
    ]);
  });

  it("rejects keys that would leave the blob directory", async () => {
    await expect(blobs.put("../outside", "x")).rejects.toThrow(
      "Invalid blob key",
    );
  });
});
