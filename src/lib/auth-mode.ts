import { z } from "zod";
import { getClientConfig } from "@/lib/client-config";

export const AUTH_MODES = [
  "cloudflare_access",
  "local_noauth",
  "hosted",
  // Self-hosted email/password sign-in: hosted's Better Auth sessions without
  // its billing, captcha, Google sign-in, or email. See
  // docs/maintainers/specs/0019-self-host-password-login.md.
  "password",
] as const;

type AuthMode = (typeof AUTH_MODES)[number];

const authModeSchema = z.enum(AUTH_MODES);

const warnedInvalidAuthModes = new Set<string>();

export function getAuthMode(value: string | null | undefined): AuthMode {
  const parsed = authModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  // Unset stays a silent fail-closed default; a SET-but-invalid value is a
  // typo the operator needs to hear about — silently coercing it made every
  // request fail with a Cloudflare Access error about a mode they never chose.
  if (value && !warnedInvalidAuthModes.has(value)) {
    warnedInvalidAuthModes.add(value);
    console.error(
      `Invalid AUTH_MODE "${value}" — falling back to "cloudflare_access". Valid values: ${AUTH_MODES.join(", ")}.`,
    );
  }

  return "cloudflare_access";
}

/**
 * The hosted product: billing, credit metering, captcha, Google sign-in and
 * email. Not a login check; use isSessionAuthMode for that.
 */
export function isHostedAuthMode(value: string | null | undefined) {
  return getAuthMode(value) === "hosted";
}

export function isPasswordAuthMode(value: string | null | undefined) {
  return getAuthMode(value) === "password";
}

/** Users sign in to OpenSEO itself (Better Auth sessions): hosted or password. */
export function isSessionAuthMode(value: string | null | undefined) {
  const mode = getAuthMode(value);
  return mode === "hosted" || mode === "password";
}

export function isHostedClientAuthMode() {
  // This is an explicit deploy-time contract: the operator must keep the
  // client build-time AUTH_MODE aligned with the server runtime AUTH_MODE.
  // We accept that tradeoff to avoid a startup round-trip just to ask the
  // backend which auth UI to render. Hosted deployments must therefore set
  // AUTH_MODE=hosted in both the client build environment and the runtime.
  return isHostedAuthMode(getClientConfig().AUTH_MODE);
}

// Same build-time AUTH_MODE contract as isHostedClientAuthMode.
export function isSessionClientAuthMode() {
  return isSessionAuthMode(getClientConfig().AUTH_MODE);
}

export function isPasswordClientAuthMode() {
  return isPasswordAuthMode(getClientConfig().AUTH_MODE);
}

export function isEmailVerificationBypassed() {
  // Local-dev escape hatch (BYPASS_EMAIL_VERIFICATION=true). The server skips
  // verification and never marks users emailVerified, so the client must treat
  // the session as verified too — otherwise route guards and /verify-email
  // bounce each other in an infinite redirect loop.
  return getClientConfig().BYPASS_EMAIL_VERIFICATION === "true";
}
