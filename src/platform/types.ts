/** Names of the deployment's string settings (vars and secrets). */
export type ConfigKey = Extract<
  {
    [K in keyof Cloudflare.Env]: Cloudflare.Env[K] extends string | undefined
      ? K
      : never;
  }[keyof Cloudflare.Env],
  keyof Cloudflare.Env
>;

// Shared shapes of the runtime seam. Each runtime module (runtime.ts for
// Workers, runtime.node.ts for Node) implements them, so swapping the module
// at build time can't change what callers see.

export interface KeyValueStore {
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
