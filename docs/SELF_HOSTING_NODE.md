# Running on Node (experimental)

OpenSEO normally runs as a Cloudflare Worker, on Cloudflare or inside the
Docker image's local Workers runtime. It can also run as a plain Node server
with a Postgres database, on any host that runs Node.

This runtime is **experimental and incomplete**. Use it to try OpenSEO on Node,
not for a production install yet.

## What works and what doesn't

| Works                                                     | Not yet                            |
| --------------------------------------------------------- | ---------------------------------- |
| Sign-in (`password`, `local_noauth`, `cloudflare_access`) | `AUTH_MODE=hosted`                 |
| Projects, keyword research, domains, backlinks, SERPs     | The operator GDPR erasure endpoint |
| Rank checks and AI-visibility runs, manual and scheduled  |                                    |
| Site audits                                               |                                    |
| SAM, the in-app chat agent (with `OPENROUTER_API_KEY`)    |                                    |
| Saved keywords, reports, settings, Search Console, GA4    |                                    |
| The MCP endpoint at `/mcp`                                |                                    |

SAM on Node uses the same prompt, project memory, tools, and skills, with
two differences: very long chats aren't summarized to save space (older tool
results are left out of what the model sees instead), and a reply cut off by a
server restart isn't resumed; send the message again.

Site audits can render JavaScript only through a Context.dev key
(`CONTEXT_API_KEY`), the same as in Docker: there is no built-in browser.

Background jobs (rank checks, AI-visibility runs, site audits) run inside the
Node process and keep their progress in Postgres. If the process restarts
mid-run, the job resumes from its last finished step about 15 minutes later.

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
- **Site-audit crawl state:** one SQLite file per running audit under
  `DURABLE_OBJECT_DIR` (default `data/durable-objects`). Files are deleted when
  an audit ends, or 7 days later if it never finishes. Run a single Node
  process per `DURABLE_OBJECT_DIR`.
