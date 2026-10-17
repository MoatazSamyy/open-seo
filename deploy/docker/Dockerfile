# Use the full Node image so workerd has a working CA trust store for outbound HTTPS.
FROM node:22

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY . .

# Build once, into the image. Client settings (AUTH_MODE and friends) are read
# at runtime (src/lib/client-config.ts), so the same build serves any .env and
# the container starts without rebuilding. The ~7400-module SSR build needs
# more than Node's ~2 GiB default heap; set it here, since .npmrc's
# node-options reaches `pnpm run` scripts but not a bare `pnpm exec`.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm exec vite build

EXPOSE 3001

# Readiness probe against the unauthenticated setup/health endpoint. The start
# period covers migrations and the local runtime booting.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

# Startup (preflight, migrations, serve) lives in
# deploy/docker/docker-entrypoint.sh.
CMD ["sh", "deploy/docker/docker-entrypoint.sh"]
