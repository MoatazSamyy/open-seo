# Sign-in for self-hosting

By default, Docker self-hosting runs with `AUTH_MODE=local_noauth`: there is
no sign-in, and anyone who can reach the app is the admin. `AUTH_MODE=password`
adds email and password sign-in, so you can put OpenSEO on the internet and
share it with your team.

## What you get

- Email and password sign-in at `/sign-in`.
- **Closed sign-up.** Only the emails you list in `ALLOWED_SIGNUP_EMAILS` can
  create an account. That includes the first one, so nobody can claim your
  server before you do.
- **One shared workspace.** The first account creates it; everyone who signs
  up after joins it as an admin, so the whole team sees the same projects.
- No billing, captcha, email verification, or emails of any kind.

## Set it up (Docker)

1. Put OpenSEO behind HTTPS. Sign-in cookies need `https://`, except on
   `http://localhost`. Any reverse proxy works (Caddy, nginx, Cloudflare
   Tunnel).
2. Add these to `.env`:

   ```sh
   AUTH_MODE=password
   BETTER_AUTH_URL=https://seo.yourdomain.com
   BETTER_AUTH_SECRET=a-long-random-string-of-at-least-32-characters
   ALLOWED_SIGNUP_EMAILS=you@yourdomain.com,teammate@yourdomain.com
   ```

   Generate the secret with `openssl rand -base64 48`. Use `@yourdomain.com`
   in `ALLOWED_SIGNUP_EMAILS` to allow a whole domain.

3. Restart: `docker compose up -d`.
4. Open `BETTER_AUTH_URL`, choose **Create account**, and sign up with your
   allowlisted email. Then ask your teammates to do the same.

## Good to know

- **Allowlisted emails aren't verified.** OpenSEO sends no email, so whoever
  signs up first with an allowlisted address gets that account. List exact
  addresses when you can, and have people sign up soon after you add them.
- **No password reset email.** If someone forgets their password, remove
  their email from the allowlist and their account from the database, then
  add the email back so they can sign up again.
- **Removing someone.** Taking an email off the allowlist stops new sign-ups
  only. An existing account keeps working until you delete it.
- **Switching from `local_noauth` keeps your projects.** The first account
  joins the workspace your projects are already in.
- **MCP isn't available in this mode yet.** Agents can't connect to the
  `/mcp` endpoint while `AUTH_MODE=password`. Use `local_noauth` on a private
  network, or Cloudflare self-hosting, if you need MCP.
