import { afterEach, describe, expect, it, vi } from "vitest";

// The database check is skipped; keep the Workers-bound db modules out.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ projects: {} }));

import { getSelfHostSetupStatus } from "@/server/lib/setup-status";

describe("getSelfHostSetupStatus", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports a complete password-mode setup as ok", async () => {
    vi.stubEnv("AUTH_MODE", "password");
    vi.stubEnv("BETTER_AUTH_URL", "https://seo.example.com");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
    vi.stubEnv("ALLOWED_SIGNUP_EMAILS", "owner@example.com");

    const status = await getSelfHostSetupStatus({ skipDatabaseCheck: true });

    expect(status.checks.auth).toMatchObject({ status: "ok" });
  });
});
