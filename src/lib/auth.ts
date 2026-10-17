import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { isDisposableEmailDomain } from "@/server/auth/disposable-email";
import * as d1Schema from "@/db/d1/schema";
import { d1Db } from "@/db/d1/client";
import { pgDb } from "@/db/pg/client";
import * as pgSchema from "@/db/pg/schema";
import { getDatabaseProvider } from "@/db/provider";
import { z } from "zod";
import {
  isHostedAuthMode,
  isPasswordAuthMode,
  isSessionAuthMode,
} from "@/lib/auth-mode";
import { createApiKeyPlugin } from "@/lib/auth-api-key";
import { createBaseAuthConfig } from "@/lib/auth-config";
import {
  getHostedTurnstileSecretKey,
  hasHostedTurnstileConfig,
} from "@/lib/auth-turnstile";
import { resolveSignInHostedOrganization } from "@/server/auth/default-hosted-organization";
import { assertPasswordSignupAllowed } from "@/server/auth/password-signup";
import { onInvitationAccepted } from "@/server/auth/invited-member";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { captureDubReferralSignup } from "@/server/referrals/dub";
import {
  sendHostedPasswordResetEmail,
  sendHostedVerificationEmail,
  upsertHostedSignupContact,
} from "@/server/email/loops";

const hostedBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && url.hostname === "localhost")
    );
  }, "BETTER_AUTH_URL must use https or localhost");

function createAuth() {
  // Sign-in modes (hosted, password) need the real configured URL (cookies,
  // callbacks, /api/auth routes all use it). Other self-hosted modes only build
  // this instance to mint/refresh Search Console tokens, which never read
  // baseURL — so a placeholder is fine there.
  const sessionMode = isSessionAuthMode(env.AUTH_MODE);
  const passwordMode = isPasswordAuthMode(env.AUTH_MODE);
  const baseUrl = sessionMode ? getHostedBaseUrl() : "http://localhost";
  // Password mode sends no email: sign-up is gated by ALLOWED_SIGNUP_EMAILS
  // instead of an inbox check, and there is no emailed password reset.
  const sendsEmail = !passwordMode;
  const bypassEmail =
    !sendsEmail || Reflect.get(env, "BYPASS_EMAIL_VERIFICATION") === "true";
  const baseAuthConfig = createBaseAuthConfig(
    sessionMode
      ? {
          organization: {
            // No sendInvitationEmail here on purpose: better-auth swallows a
            // throw from that callback, so a failed send would still read as
            // "sent" in the UI. The invite email is sent (and rate limited)
            // by the sendTeamInvitation server function instead, which fails
            // the call visibly. Side effect worth knowing: hitting the raw
            // /api/auth/organization/invite-member endpoint creates a pending
            // invitation but emails nobody.
            organizationHooks: {
              // The invite UI only offers "admin", but the endpoint accepts
              // any role string; enforce server-side. This also keeps an
              // owner from minting a second owner and leaving — the path
              // that would re-mint a fresh org + free-plan grant at next
              // sign-in.
              beforeCreateInvitation: async ({ invitation }) => {
                if (invitation.role !== "admin") {
                  throw new APIError("BAD_REQUEST", {
                    message: "Teammates can only be invited as admins.",
                  });
                }
              },
              beforeAcceptInvitation: async ({ invitation, user }) => {
                const existing = await AuthRepository.getMembership(
                  user.id,
                  invitation.organizationId,
                );
                if (existing) {
                  throw new APIError("BAD_REQUEST", {
                    message: "You are already a member of this organization.",
                  });
                }
              },
              // The invite flow only ever mints "admin", but the raw
              // update-member-role endpoint accepts any role string and the
              // plugin lets an owner grant owner to another member. Owners
              // control billing, so a second owner is a billing-escalation
              // path (and, if the first owner then leaves, a fresh-org /
              // free-grant loop at next sign-in). Ownership moves only through
              // the transferOwnership server function, which swaps the two
              // roles atomically — reject owner here.
              beforeUpdateMemberRole: async ({ newRole }) => {
                if (
                  newRole
                    .split(",")
                    .map((r) => r.trim())
                    .includes("owner")
                ) {
                  throw new APIError("BAD_REQUEST", {
                    message:
                      "The owner role can't be granted from here. Use Transfer ownership in organization settings.",
                  });
                }
              },
              afterAcceptInvitation: async ({ member: acceptedMember }) => {
                await onInvitationAccepted({
                  userId: acceptedMember.userId,
                  organizationId: acceptedMember.organizationId,
                });
              },
            },
          },
        }
      : undefined,
  );

  // Turnstile captcha on signup — hosted only. Enforcement is driven by the
  // server-side secret alone so a client build/runtime site-key mismatch cannot
  // silently omit the Better Auth captcha plugin. Hosted deployments that expose
  // the client widget without the matching server secret fail configuration
  // checks instead of presenting a bypassable captcha.
  const turnstileSecretKey = getHostedTurnstileSecretKey(env);

  const database =
    getDatabaseProvider() === "postgres"
      ? drizzleAdapter(pgDb, {
          provider: "pg",
          schema: pgSchema,
        })
      : drizzleAdapter(d1Db, {
          provider: "sqlite",
          schema: d1Schema,
        });

  const auth = betterAuth({
    baseURL: baseUrl,
    secret: getHostedSecret(),
    logger: {
      log: (level, message, ...args: unknown[]) => {
        // The api-key plugin logs every verification failure at error level — a
        // stale key or a throttled caller included. The /mcp handler already logs
        // the response it returns at the right level (debug for 401, warn for 429),
        // so drop the duplicate.
        if (message.startsWith("Failed to validate API key")) return;
        // "Failed to parse state" is user/browser behavior: a replayed OAuth
        // callback URL (back button, restored tab), or a consent screen left
        // open past the state's lifetime. The request already redirects the
        // user to an error page; nothing here is on-call actionable.
        const effectiveLevel =
          level === "error" && message === "Failed to parse state"
            ? "warn"
            : level;
        // Also drops Better Auth's ISO-timestamp prefix, which makes every log
        // line fingerprint as its own error group in observability.
        console[effectiveLevel === "debug" ? "log" : effectiveLevel](
          `[better-auth] ${message}`,
          ...args,
        );
      },
    },
    ...baseAuthConfig,
    emailAndPassword: {
      ...baseAuthConfig.emailAndPassword,
      requireEmailVerification: !bypassEmail,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(sendsEmail
        ? {
            sendResetPassword: async ({ user, url }) => {
              await sendHostedPasswordResetEmail({
                email: user.email,
                resetUrl: url,
              });
            },
          }
        : {}),
    },
    emailVerification: bypassEmail
      ? undefined
      : {
          sendOnSignUp: true,
          autoSignInAfterVerification: true,
          sendVerificationEmail: async ({ user, url }) => {
            await sendHostedVerificationEmail({
              email: user.email,
              confirmationUrl: url,
            });
          },
        },
    socialProviders: getSocialProviders(),
    // Where Google sign-in failures land (canceled consent screen, replayed
    // callback URLs). Without this the default /api/auth/error page 302s to
    // `/?error=...` and the dashboard silently discards the code. Self-hosted
    // never serves social sign-in, so the placeholder baseUrl there is
    // harmless.
    onAPIError: { errorURL: `${baseUrl}/auth-error` },
    trustedOrigins: getTrustedOrigins(baseUrl),
    database,
    plugins: [
      ...baseAuthConfig.plugins,
      ...(isHostedAuthMode(env.AUTH_MODE) ? [createApiKeyPlugin()] : []),
      ...(turnstileSecretKey
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: turnstileSecretKey,
              endpoints: ["/sign-up/email"],
            }),
          ]
        : []),
      tanstackStartCookies(),
    ],
    databaseHooks: {
      user: {
        create: {
          // Hosted only: keep cheap mass-signups off the free plan by rejecting
          // throwaway-inbox domains before the user row is created. Self-hosted
          // has no shared credit pool to protect, so it's left untouched.
          before: async (user) => {
            if (
              isHostedAuthMode(env.AUTH_MODE) &&
              isDisposableEmailDomain(user.email)
            ) {
              throw new APIError("BAD_REQUEST", {
                message: "Please sign up with a non-disposable email address.",
              });
            }
            if (passwordMode) {
              assertPasswordSignupAllowed(user.email);
              // The allowlist is the trust check here, so the account counts
              // as verified and the client's verify-email gate never fires.
              return { data: { ...user, emailVerified: true } };
            }
            return { data: user };
          },
          after: async (user, ctx) => {
            if (passwordMode) return;
            await syncHostedSignupContact(user);
            if (isHostedAuthMode(env.AUTH_MODE)) {
              await captureDubReferralSignup(user.id, ctx?.request);
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (passwordMode) {
              await joinSharedPasswordWorkspace(session.userId);
            }
            // Runs on every sign-in (each sign-in mints a session row).
            // Resolution order: last-active org while still a member → most
            // recently joined org → newly created default organization —
            // except that a membership-less user with a pending invitation
            // gets no organization minted (null active org) so accepting the invite
            // leaves them in exactly the inviter's org. Inject Better Auth's
            // createOrganization so the helper can stay reusable without
            // importing auth.ts and creating a cycle.
            const resolved = await resolveSignInHostedOrganization(
              session.userId,
              (body) => auth.api.createOrganization({ body }),
            );

            return {
              data: {
                ...session,
                activeOrganizationId: resolved?.organizationId ?? null,
              },
            };
          },
        },
      },
    },
  });

  // Password mode runs one workspace per install so teammates share projects.
  // Called from the session hook (Better Auth runs user-create "after" hooks
  // only once the first session exists): a user with no membership joins the
  // oldest workspace as an admin, so the org resolution below finds it instead
  // of minting a new one. The very first account has nothing to join and gets
  // the workspace created for it.
  async function joinSharedPasswordWorkspace(userId: string) {
    if (await AuthRepository.findFirstOrganizationIdForUser(userId)) return;
    const organizationId = await AuthRepository.findOldestOrganizationId();
    if (!organizationId) return;
    await auth.api.addMember({
      body: { userId, organizationId, role: "admin" },
    });
  }

  return auth;
}

let authInstance: ReturnType<typeof createAuth> | null = null;

async function syncHostedSignupContact(user: {
  id: string;
  email: string;
  name?: string | null;
}) {
  try {
    await upsertHostedSignupContact({
      userId: user.id,
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    console.error("Failed to sync Loops profile after user creation:", {
      userId: user.id,
      email: user.email,
      error,
    });
  }
}

function getTrustedOrigins(baseUrl: string) {
  const trustedOrigins = [baseUrl];

  if (process.env.NODE_ENV !== "production") {
    trustedOrigins.push(
      "http://open-seo.localhost:1355",
      "http://*.open-seo.localhost:1355",
      "https://open-seo.localhost:1355",
      "https://*.open-seo.localhost:1355",
    );
  }

  return trustedOrigins;
}

export function getHostedBaseUrl() {
  const baseUrl = env.BETTER_AUTH_URL?.trim();

  if (!baseUrl) {
    throw new Error("BETTER_AUTH_URL is required in hosted and password modes");
  }

  return hostedBaseUrlSchema.parse(baseUrl);
}

// Required in hosted mode, and in self-hosted mode when Search Console is
// enabled (it keys the OAuth-token encryption and is needed to build the auth
// instance that mints/refreshes Search Console tokens).
function getHostedSecret() {
  const secret = env.BETTER_AUTH_SECRET?.trim();

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is required");
  }

  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }

  return secret;
}

function getSocialProviders() {
  // Google social login is hosted-only. Self-hosted builds the auth instance
  // for sessions and for the token-encryption secret that Search Console /
  // Analytics grants use (googleOAuth.ts) — so it must NOT require the
  // social-login config here, otherwise getAuth() construction would be coupled
  // to Google creds rather than just BETTER_AUTH_SECRET.
  if (!isHostedAuthMode(env.AUTH_MODE)) {
    return {};
  }

  return {
    google: getGoogleSocialProviderConfig(),
  };
}

function getGoogleSocialProviderConfig() {
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();

  if (!googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID is required in hosted mode");
  }

  if (!googleClientSecret) {
    throw new Error("GOOGLE_CLIENT_SECRET is required in hosted mode");
  }

  return {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    mapProfileToUser: (profile: { name?: string }) => ({
      name: profile.name,
    }),
  };
}

function hasHostedAuthEmailConfig() {
  const loopsVars = [
    "LOOPS_API_KEY",
    "LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID",
    "LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID",
  ];

  return loopsVars.every((name) => {
    const value: unknown = Reflect.get(env, name);
    return typeof value === "string" && value.trim() !== "";
  });
}

/**
 * Whether the configuration for the current sign-in mode is complete:
 * hosted's full set, or password mode's base URL and secret.
 */
export function hasSessionAuthConfig() {
  if (!isPasswordAuthMode(env.AUTH_MODE)) return hasHostedAuthConfig();
  try {
    getHostedBaseUrl();
    getHostedSecret();
    return true;
  } catch {
    return false;
  }
}

function hasHostedAuthConfig() {
  try {
    getHostedBaseUrl();
    getHostedSecret();
    getGoogleSocialProviderConfig();
    return (
      hasHostedTurnstileConfig(env) &&
      (Reflect.get(env, "BYPASS_EMAIL_VERIFICATION") === "true" ||
        hasHostedAuthEmailConfig())
    );
  } catch {
    return false;
  }
}

export function getAuth() {
  if (authInstance) {
    return authInstance;
  }

  authInstance = createAuth();

  return authInstance;
}
