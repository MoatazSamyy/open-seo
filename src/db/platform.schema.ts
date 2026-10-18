import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Key-value store for runtimes without Workers KV (the Node runtime's `kv` in
// src/platform/runtime.node.ts). Unused on Cloudflare, where `kv` is Workers KV.
export const platformKv = sqliteTable("platform_kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
});
