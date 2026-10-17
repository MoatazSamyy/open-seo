import { env, waitUntil as workersWaitUntil } from "cloudflare:workers";

// The app's seam to its runtime: config, work that outlives the response, a
// key-value store, and blob storage. This is the Cloudflare Workers
// implementation; a Node runtime swaps this module (fork milestone 3c, see
// docs/maintainers/fork-roadmap.md). Workflow, Durable Object, and Browser
// bindings are not here yet; those files still import cloudflare:workers.
//
// Every member reads `env` at call time, not import time, so tests that mock
// cloudflare:workers and fill the mock in beforeEach keep working.

type ConfigKey = Extract<
  {
    [K in keyof Cloudflare.Env]: Cloudflare.Env[K] extends string | undefined
      ? K
      : never;
  }[keyof Cloudflare.Env],
  keyof Cloudflare.Env
>;

/** A string setting (var or secret) from the deployment's config. */
export function getConfig<K extends ConfigKey>(name: K): Cloudflare.Env[K] {
  return env[name];
}

/**
 * The same, for a setting whose name is only known at runtime or isn't in the
 * Env type. Empty strings read as unset.
 */
export function getConfigByName(name: string): string | undefined {
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Keep the request alive until `promise` settles, without making the response
 * wait for it. Throws outside a request (Workflow steps, tests), like the
 * Workers API it wraps.
 */
export function waitUntil(promise: Promise<unknown>): void {
  workersWaitUntil(promise);
}

interface KeyValueStore {
  get(key: string): Promise<string | null>;
  getJson(key: string, options?: { cacheTtl?: number }): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  /** One page of keys; `cursor` is set only when more pages follow. */
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ keys: string[]; cursor?: string }>;
}

export const kv: KeyValueStore = {
  get: (key) => env.KV.get(key),
  getJson: (key, options) =>
    env.KV.get(key, { type: "json", cacheTtl: options?.cacheTtl }),
  put: (key, value, options) =>
    options ? env.KV.put(key, value, options) : env.KV.put(key, value),
  delete: (key) => env.KV.delete(key),
  list: async ({ prefix, cursor }) => {
    const page = await env.KV.list({ prefix, cursor });
    return {
      keys: page.keys.map((key) => key.name),
      cursor: page.list_complete ? undefined : page.cursor,
    };
  },
};

export interface StoredBlob {
  key: string;
  customMetadata: Record<string, string>;
}

export interface BlobWithBody extends StoredBlob {
  text(): Promise<string>;
  body: ReadableStream;
}

export interface BlobStore {
  get(key: string): Promise<BlobWithBody | null>;
  put(
    key: string,
    value: string,
    options?: { contentType?: string; customMetadata?: Record<string, string> },
  ): Promise<void>;
  /** Up to 1,000 keys per call. */
  delete(keys: string | string[]): Promise<void>;
  /** One page, with custom metadata; `cursor` is set only when more follow. */
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: StoredBlob[]; cursor?: string }>;
}

export const blobs: BlobStore = {
  get: async (key) => {
    const object = await env.R2.get(key);
    if (!object) return null;
    return {
      key: object.key,
      customMetadata: object.customMetadata ?? {},
      text: () => object.text(),
      body: object.body,
    };
  },
  put: async (key, value, options) => {
    await env.R2.put(key, value, {
      ...(options?.contentType
        ? { httpMetadata: { contentType: options.contentType } }
        : {}),
      ...(options?.customMetadata
        ? { customMetadata: options.customMetadata }
        : {}),
    });
  },
  delete: (keys) => env.R2.delete(keys),
  list: async ({ prefix, cursor, limit }) => {
    const page = await env.R2.list({
      prefix,
      cursor,
      limit,
      include: ["customMetadata"],
    });
    return {
      objects: page.objects.map((object) => ({
        key: object.key,
        customMetadata: object.customMetadata ?? {},
      })),
      cursor: page.truncated ? page.cursor : undefined,
    };
  },
};
