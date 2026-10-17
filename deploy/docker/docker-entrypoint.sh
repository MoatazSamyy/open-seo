#!/bin/sh
# Self-host container entrypoint: preflight, migrations, then serve the build
# the image already contains. Client settings are read at runtime
# (src/lib/client-config.ts), so a changed .env never needs a rebuild.
set -e

echo 'OpenSEO sends an anonymous usage heartbeat (counts only). Disable: OPENSEO_TELEMETRY_DISABLED=1. Details: docs/SELF_HOSTING_DOCKER.md#telemetry'

# The preflight validates env BEFORE the slow steps, so misconfiguration fails
# in seconds with the exact fix.
pnpm exec tsx scripts/selfhost-preflight.ts

pnpm run db:migrate:local

# Images built before the build moved into the Dockerfile, or a checkout
# mounted over /app, have no build output yet.
if [ ! -d dist/client ]; then
  echo "No build found in the image; building client + server..."
  NODE_OPTIONS=--max-old-space-size=4096 pnpm exec vite build
fi

# The local preview runtime exposes scheduled handlers but does not emit cron
# events by itself. The supervisor runs preview and the loopback scheduler together.
exec node scripts/selfhost-scheduler.mjs
