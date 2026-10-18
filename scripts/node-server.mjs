// Runs OpenSEO on Node (fork milestone 3c): applies Postgres migrations, serves
// the dist-node/ build with srvx, and runs the five-minute cron on a timer.
// Build first with `pnpm build:node`. See docs/SELF_HOSTING_NODE.md.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { serve } from "srvx";
import { serveStatic } from "srvx/static";

const CRON_INTERVAL_MS = 5 * 60_000;
const FIRST_CRON_DELAY_MS = 60_000;

// Node always runs on Postgres.
process.env.DATABASE_PROVIDER ||= "postgres";
if (process.env.DATABASE_PROVIDER !== "postgres") {
  throw new Error("The Node runtime needs DATABASE_PROVIDER=postgres.");
}
const databaseUrl = process.env.POSTGRES_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("Set POSTGRES_DATABASE_URL to run OpenSEO on Node.");
}

const root = process.cwd();

async function applyMigrations() {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: path.join(root, "drizzle/pg"),
    });
  } finally {
    await sql.end();
  }
}

await applyMigrations();
console.log("[node] database migrations applied");

const app = await import(
  pathToFileURL(path.join(root, "dist-node/server/server.node.js")).href
);

const server = serve({
  port: Number(process.env.PORT ?? 3001),
  hostname: process.env.HOST ?? "0.0.0.0",
  middleware: [serveStatic({ dir: path.join(root, "dist-node/client") })],
  fetch: (request) => app.default.fetch(request),
});
await server.ready();
console.log(`[node] OpenSEO listening on ${server.url}`);

app.startWorkflows();
console.log("[node] workflow runner started");

// One run at a time: a slow tick is skipped rather than overlapped.
let cronRunning = false;
async function runCron() {
  if (cronRunning) return;
  cronRunning = true;
  try {
    await app.runScheduledJobs();
  } catch (error) {
    console.error("[scheduler] scheduled jobs failed:", error);
  } finally {
    cronRunning = false;
  }
}
setTimeout(() => {
  void runCron();
  setInterval(() => void runCron(), CRON_INTERVAL_MS);
}, FIRST_CRON_DELAY_MS);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
