import { describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  ALLOWED_SIGNUP_EMAILS: "Owner@Example.com, @team.example.org",
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));

import { assertPasswordSignupAllowed } from "@/server/auth/password-signup";

describe("assertPasswordSignupAllowed", () => {
  it.each(["owner@example.com", "  OWNER@example.com", "dev@team.example.org"])(
    "allows %s from the allowlist",
    (email) => {
      expect(() => assertPasswordSignupAllowed(email)).not.toThrow();
    },
  );

  it.each([
    "other@example.com",
    // A domain entry must not match a look-alike domain.
    "dev@notteam.example.org",
    "dev@team.example.org.evil.com",
  ])("rejects %s", (email) => {
    expect(() => assertPasswordSignupAllowed(email)).toThrow(
      "Sign-up is closed",
    );
  });
});
