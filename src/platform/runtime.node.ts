import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, gt, gte, lt } from "drizzle-orm";
import { sort } from "remeda";
import type {
  BlobStore,
  ConfigKey,
  KeyValueStore,
  StoredBlob,
} from "@/platform/types";

// The Node implementation of the runtime seam (see runtime.ts for the Workers
// one). The Node build aliases "@/platform/runtime" to this module. Config is
// process.env, KV is the platform_kv table in Postgres, and blobs are files
// under BLOB_DIR.

export type { BlobStore, StoredBlob } from "@/platform/types";

export function getConfig(name: ConfigKey): string | undefined {
  return getConfigByName(name);
}

export function getConfigByName(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

export function getPostgresUrl(): string | undefined {
  return getConfigByName("POSTGRES_DATABASE_URL")?.trim() || undefined;
}

/** One pooled client per process; see withPgClient. */
export const postgresClientLifetime: "request" | "process" = "process";

/**
 * Node keeps running after the response, so there is nothing to extend; just
 * make sure a failure is logged instead of becoming an unhandled rejection.
 */
export function waitUntil(promise: Promise<unknown>): void {
  promise.catch((error: unknown) => {
    console.error("[waitUntil] background work failed:", error);
  });
}

// The db modules import this one, so they're loaded on first use, not at
// import time, to keep the module graph acyclic.
async function kvTable() {
  const [{ db }, { platformKv }] = await Promise.all([
    import("@/db"),
    import("@/db/schema"),
  ]);
  return { db, platformKv };
}

const KV_LIST_PAGE_SIZE = 1000;

export const kv: KeyValueStore = {
  async get(key) {
    const { db, platformKv } = await kvTable();
    const [row] = await db
      .select({ value: platformKv.value, expiresAt: platformKv.expiresAt })
      .from(platformKv)
      .where(eq(platformKv.key, key))
      .limit(1);
    if (!row) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      await db.delete(platformKv).where(eq(platformKv.key, key));
      return null;
    }
    return row.value;
  },
  async getJson(key) {
    const value = await kv.get(key);
    if (value === null) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed;
    } catch {
      return null;
    }
  },
  async put(key, value, options) {
    const { db, platformKv } = await kvTable();
    const expiresAt = options?.expirationTtl
      ? new Date(Date.now() + options.expirationTtl * 1000)
      : null;
    await db
      .insert(platformKv)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({
        target: platformKv.key,
        set: { value, expiresAt },
      });
  },
  async delete(key) {
    const { db, platformKv } = await kvTable();
    await db.delete(platformKv).where(eq(platformKv.key, key));
  },
  async list({ prefix, cursor }) {
    const { db, platformKv } = await kvTable();
    // A key range instead of LIKE, so "%" or "_" in a prefix match literally.
    const rows = await db
      .select({ key: platformKv.key })
      .from(platformKv)
      .where(
        and(
          gte(platformKv.key, prefix),
          lt(platformKv.key, `${prefix}￿`),
          cursor ? gt(platformKv.key, cursor) : undefined,
        ),
      )
      .orderBy(asc(platformKv.key))
      .limit(KV_LIST_PAGE_SIZE);
    const keys = rows.map((row) => row.key);
    return {
      keys,
      cursor: keys.length === KV_LIST_PAGE_SIZE ? keys.at(-1) : undefined,
    };
  },
};

// Blob files live under <BLOB_DIR>/objects/<key>, with their custom metadata
// in <BLOB_DIR>/meta/<key>.json.
function blobRoot() {
  return path.resolve(getConfigByName("BLOB_DIR") ?? "data/blobs");
}

function blobPaths(key: string) {
  const segments = key.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`Invalid blob key "${key}"`);
  }
  return {
    object: path.join(blobRoot(), "objects", ...segments),
    meta: `${path.join(blobRoot(), "meta", ...segments)}.json`,
  };
}

async function readMetadata(key: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(blobPaths(key).meta, "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Every blob key under `dir` (a directory inside objects/), recursively. */
async function walkKeys(dir: string, keyPrefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const keys: string[] = [];
  for (const entry of entries) {
    const key = `${keyPrefix}${entry.name}`;
    if (entry.isDirectory()) {
      keys.push(...(await walkKeys(path.join(dir, entry.name), `${key}/`)));
    } else {
      keys.push(key);
    }
  }
  return keys;
}

const BLOB_LIST_DEFAULT_LIMIT = 1000;

export const blobs: BlobStore = {
  async get(key) {
    let data: Buffer;
    try {
      data = await readFile(blobPaths(key).object);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    return {
      key,
      customMetadata: await readMetadata(key),
      text: () => Promise.resolve(data.toString("utf8")),
      body: new Blob([new Uint8Array(data)]).stream(),
    };
  },
  async put(key, value, options) {
    const paths = blobPaths(key);
    await mkdir(path.dirname(paths.object), { recursive: true });
    await mkdir(path.dirname(paths.meta), { recursive: true });
    await writeFile(paths.object, value);
    await writeFile(paths.meta, JSON.stringify(options?.customMetadata ?? {}));
  },
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const paths = blobPaths(key);
      await rm(paths.object, { force: true });
      await rm(paths.meta, { force: true });
    }
  },
  async list({ prefix, cursor, limit = BLOB_LIST_DEFAULT_LIMIT }) {
    // Walk from the prefix's deepest directory, then filter by the full prefix.
    const dirPrefix = prefix.slice(0, prefix.lastIndexOf("/") + 1);
    const dir = path.join(blobRoot(), "objects", ...dirPrefix.split("/"));
    const keys = sort(
      (await walkKeys(dir, dirPrefix)).filter(
        (key) => key.startsWith(prefix) && (!cursor || key > cursor),
      ),
      (a, b) => (a < b ? -1 : 1),
    );
    const page = keys.slice(0, limit);
    const objects: StoredBlob[] = await Promise.all(
      page.map(async (key) => ({
        key,
        customMetadata: await readMetadata(key),
      })),
    );
    return {
      objects,
      cursor: keys.length > limit ? page.at(-1) : undefined,
    };
  },
};
