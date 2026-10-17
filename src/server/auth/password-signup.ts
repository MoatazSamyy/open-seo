import { APIError } from "better-auth/api";
import { getConfigByName } from "@/platform/runtime";

// Who may create an account in AUTH_MODE=password. The deployment is the
// operator's own DataForSEO bill, so sign-up is closed except to the emails
// (or "@domain" entries) in ALLOWED_SIGNUP_EMAILS. That includes the first
// account, so nobody can claim a freshly exposed server before its operator.

/**
 * Whether an email matches a comma-separated allowlist of exact addresses
 * and "@domain" entries, case-insensitively.
 */
function isAllowedSignupEmail(email: string, allowlist: string) {
  const address = email.trim().toLowerCase();
  return allowlist
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) =>
      entry.startsWith("@") ? address.endsWith(entry) : address === entry,
    );
}

export function assertPasswordSignupAllowed(email: string) {
  const allowlist: unknown = getConfigByName("ALLOWED_SIGNUP_EMAILS");
  if (typeof allowlist === "string" && isAllowedSignupEmail(email, allowlist)) {
    return;
  }
  throw new APIError("FORBIDDEN", {
    message:
      "Sign-up is closed on this OpenSEO server. Ask its owner to add your email to ALLOWED_SIGNUP_EMAILS.",
  });
}
