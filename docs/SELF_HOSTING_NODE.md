# Running on Node (experimental)

OpenSEO normally runs as a Cloudflare Worker, on Cloudflare or inside the
Docker image's local Workers runtime. It can also run as a plain Node server
with a Postgres database, on any host that runs Node.

This runtime is **experimental and incomplete**. Use it to try OpenSEO on Node,
not for a production install yet.

## What works and what doesn't

| Works                                                     | Not yet                                                 |
| --------------------------------------------------------- | ------------------------------------------------------- |
| Sign-in (`password`, `local_noauth`, `cloudflare_access`) | `AUTH_MODE=hosted`                                      |
| Projects, keyword research, domains, backlinks, SERPs     | Rank checks and AI-visibility runs (they use Workflows) |
| Saved keywords, reports, settings, Search Console, GA4    | Site audits                                             |
| The MCP endpoint at `/mcp`                                | SAM, the in-app chat agent                              |
| The five-minute scheduler                                 | The operator GDPR erasure endpoint                      |

Starting a rank check, an AI-visibility run, or a site audit shows an error
that names the missing piece.

## Run it

You need Node 22 or newer and a Postgres database.

```sh
pnpm install --frozen-lockfile
pnpm build:node
```

Set these environment variables (in your shell or your process manager):

```sh
POSTGRES_DATABASE_URL=postgres://user:password@host:5432/openseo
DATAFORSEO_API_KEY=your-base64-dataforseo-key
AUTH_MODE=password
BETTER_AUTH_URL=https://seo.yourdomain.com
BETTER_AUTH_SECRET=a-long-random-string-of-at-least-32-characters
ALLOWED_SIGNUP_EMAILS=you@yourdomain.com
```

See [`SELF_HOSTING_LOGIN.md`](./SELF_HOSTING_LOGIN.md) for the sign-in
settings. Then start the server:

```sh
pnpm start:node
```

It applies database migrations, then listens on `PORT` (default `3001`).

## Storage

- **Database:** Postgres only. Migrations run at every start.
- **Files** (exports and cached responses): stored on disk under `BLOB_DIR`,
  which defaults to `data/blobs` in the working directory. Keep it on a
  persistent volume.
- **Short-lived values** (caches, counters): stored in the `platform_kv` table.
