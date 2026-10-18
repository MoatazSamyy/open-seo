import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Key-value store for runtimes without Workers KV (the Node runtime's `kv` in
// src/platform/runtime.node.ts). Unused on Cloudflare, where `kv` is Workers KV.
export const platformKv = pgTable("platform_kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
});
