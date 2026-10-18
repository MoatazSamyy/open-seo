import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
  env: {},
}));

import { AuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import { createDurableObjectNamespace } from "./durable-objects";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openseo-objects-"));
  vi.stubEnv("DURABLE_OBJECT_DIR", dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function scratchpads() {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the scratchpad doesn't read env
  const env = {} as Env;
  return createDurableObjectNamespace("AUDIT_SCRATCHPAD", AuditScratchpad, env);
}

describe("Node Durable Objects", () => {
  it("runs the audit scratchpad's SQL in a file per audit", async () => {
    const namespace = scratchpads();
    const pad = namespace.get(namespace.idFromName("audit-1"));

    await pad.seedStart("https://example.com/");
    await pad.seedSitemapUrls([
      "https://example.com/",
      "https://example.com/a",
    ]);

    expect(await pad.getStats()).toEqual({ attempted: 0, pending: 2, seen: 2 });
    expect(
      existsSync(path.join(dir, "AUDIT_SCRATCHPAD", "audit-1.sqlite")),
    ).toBe(true);
  });

  it("wipes a scratchpad whose cleanup alarm comes due", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-01T00:00:00Z"),
      toFake: ["Date"],
    });
    const namespace = scratchpads();
    await namespace
      .get(namespace.idFromName("abandoned"))
      .seedStart("https://example.com/");

    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    await namespace.runDueAlarms();

    const fresh = namespace.get(namespace.idFromName("abandoned"));
    expect(await fresh.getStats()).toEqual({
      attempted: 0,
      pending: 0,
      seen: 0,
    });
  });
});
