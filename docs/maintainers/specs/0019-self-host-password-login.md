# 0019 — Self-host password login

## Status

Proposed (October 2026), fork milestone 2.

## Context

Self-hosters pick between `local_noauth` (no sign-in; the Docker default) and
`cloudflare_access` (Cloudflare Zero Trust in front). Neither lets a Docker
install go on the public internet with its own logins. The `hosted` mode has
real sign-in through Better Auth, but it also turns on everything the hosted
product needs: billing and credit metering, Turnstile, Google sign-in, Loops
email, PostHog, and referral tracking. `isHostedAuthMode` was used for both
meanings.

## Decision

1. **A fourth auth mode, `password`.** It uses the same Better Auth sessions,
   `/api/auth` routes, and session middleware as `hosted`, and none of the
   hosted product. Code now asks one of two questions:
   `isSessionAuthMode` (users sign in to OpenSEO: hosted or password) or
   `isHostedAuthMode` (the hosted product). Every billing, analytics, and
   email check stays on `isHostedAuthMode`, so password mode meters nothing
   and sends nothing.
2. **Sign-up is closed by an allowlist.** `ALLOWED_SIGNUP_EMAILS` (exact
   addresses and `@domain` entries) is required, and the user-create hook
   rejects any other email. It applies to the first account too, so a freshly
   exposed server can't be claimed by a stranger. The operator pays for
   DataForSEO, so open sign-up would hand out their credits.
3. **Allowlisted accounts count as verified.** Password mode sends no email,
   so new users are created with `emailVerified: true` and the client's
   verify-email gate never fires. Password reset, which needs an emailed
   link, is off and its link is hidden.
4. **One workspace per install.** The first account gets a workspace created
   at its first sign-in, as in hosted. At each sign-in, an account with no
   membership is added to the oldest workspace as an admin before the
   session's organization is resolved, so teammates share projects. This runs
   in the session hook because Better Auth runs user-create "after" hooks only
   once the first session exists. Switching an install from
   `local_noauth` keeps its data the same way, because the delegated admin's
   workspace is the oldest one.
5. **Hosted-only pages stay hosted-only.** Onboarding, plans, billing, team
   invitations, and MCP OAuth consent check `isHostedAuthMode` directly.

## Alternatives considered

- **Reuse `hosted` with the product parts switched off by flags.** Rejected:
  every billing site would need a second condition, and a missed one would
  meter or block a self-hoster.
- **First account becomes owner, open sign-up after that.** Rejected: the
  first account would be a race on a fresh deploy, and open sign-up spends
  the operator's DataForSEO balance.
- **A workspace per user with invitations.** Rejected for self-hosting:
  invitations are emailed, and a team expects one shared set of projects.

## Consequences

- Docker installs can be exposed behind HTTPS with real accounts.
  `BETTER_AUTH_URL` must be `https://` or `http://localhost`.
- Allowlisted addresses aren't proven to belong to whoever signs up with
  them; the operator guide says to list exact addresses.
- MCP is not served in password mode. Hosted MCP runs through the OAuth
  provider, which needs hosted's KV and API-key plugin; a password-mode MCP
  path is follow-up work.
- Removing an email from the allowlist stops new sign-ups only; deleting an
  account is a database action.
