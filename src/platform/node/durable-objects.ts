import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// In-process Durable Objects for the Node runtime (fork milestone 3e), for
// the objects the app still uses (the site-audit crawl scratchpad). See
// docs/maintainers/specs/0022-node-site-audits.md.
//
// Each object keeps its storage in its own SQLite file, like a SQLite-backed
// Durable Object, so its SQL runs unchanged. Methods are called directly on
// one cached instance per object name instead of over RPC. Alarms are a
// timestamp file that runDueAlarms() fires; the Node cron calls it.

function storageRoot() {
  return path.resolve(
    process.env.DURABLE_OBJECT_DIR?.trim() || "data/durable-objects",
  );
}

class SqlCursor<T> {
  constructor(private readonly rows: T[]) {}

  toArray(): T[] {
    return this.rows;
  }

  one(): T {
    if (this.rows.length !== 1) {
      throw new Error(`Expected exactly one row, got ${this.rows.length}`);
    }
    return this.rows[0];
  }
}

function toSqlValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throw new Error(`Unsupported SQL binding of type ${typeof value}`);
}

/** Several `;`-separated statements, which only exec() can run. */
function isMultiStatement(query: string) {
  return query.trim().replace(/;\s*$/, "").includes(";");
}

class NodeDurableObjectStorage {
  private db: DatabaseSync | null = null;

  constructor(
    private readonly file: string,
    private readonly alarmFile: string,
    private readonly onDeleteAll: () => void,
  ) {}

  private open(): DatabaseSync {
    if (!this.db) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.db = new DatabaseSync(this.file);
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS _do_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
    }
    return this.db;
  }

  get sql() {
    const db = this.open();
    return {
      exec<T>(query: string, ...bindings: unknown[]): SqlCursor<T> {
        if (bindings.length === 0 && isMultiStatement(query)) {
          db.exec(query);
          return new SqlCursor<T>([]);
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rows have the shape the caller's query selects, as with the Workers API
        const rows = db.prepare(query).all(...bindings.map(toSqlValue)) as T[];
        return new SqlCursor(rows);
      },
      get databaseSize(): number {
        const pages = db.prepare("PRAGMA page_count").get();
        const size = db.prepare("PRAGMA page_size").get();
        return Number(pages?.page_count ?? 0) * Number(size?.page_size ?? 0);
      },
    };
  }

  get<T>(key: string): Promise<T | undefined> {
    const row = this.open()
      .prepare("SELECT value FROM _do_kv WHERE key = ?")
      .get(key);
    if (!row) return Promise.resolve(undefined);
    const value: unknown = JSON.parse(String(row.value));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- values are whatever the object stored under this key
    return Promise.resolve(value as T);
  }

  put(key: string, value: unknown): Promise<void> {
    this.open()
      .prepare("INSERT OR REPLACE INTO _do_kv (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(value));
    return Promise.resolve();
  }

  /** Drops all stored data. Like Workers, it leaves the alarm alone. */
  deleteAll(): Promise<void> {
    this.db?.close();
    this.db = null;
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${this.file}${suffix}`, { force: true });
    }
    this.onDeleteAll();
    return Promise.resolve();
  }

  getAlarm(): Promise<number | null> {
    try {
      return Promise.resolve(Number(readFileSync(this.alarmFile, "utf8")));
    } catch {
      return Promise.resolve(null);
    }
  }

  setAlarm(time: number | Date): Promise<void> {
    mkdirSync(path.dirname(this.alarmFile), { recursive: true });
    writeFileSync(this.alarmFile, String(Number(time)));
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    rmSync(this.alarmFile, { force: true });
    return Promise.resolve();
  }
}

/**
 * A namespace binding (idFromName / get) whose objects live in this process,
 * one cached instance per name.
 */
export function createDurableObjectNamespace<
  Instance extends { alarm?: () => Promise<void> },
>(
  binding: string,
  ObjectClass: new (state: DurableObjectState, env: Env) => Instance,
  env: Env,
) {
  const dir = path.join(storageRoot(), binding);
  const instances = new Map<string, Instance>();

  function get(id: { name: string }): Instance {
    const existing = instances.get(id.name);
    if (existing) return existing;
    const fileName = encodeURIComponent(id.name);
    // Like Workers, nothing reaches the object until the work its constructor
    // started with blockConcurrencyWhile has finished.
    let ready: Promise<unknown> = Promise.resolve();
    const state = {
      id: { name: id.name, toString: () => id.name },
      storage: new NodeDurableObjectStorage(
        path.join(dir, `${fileName}.sqlite`),
        path.join(dir, `${fileName}.alarm`),
        () => instances.delete(id.name),
      ),
      blockConcurrencyWhile: <T>(fn: () => Promise<T>) => {
        const result = fn();
        ready = ready.then(() => result);
        return result;
      },
      waitUntil: (promise: Promise<unknown>) => void promise,
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node implements the subset of DurableObjectState these objects use
    const object = new ObjectClass(state as unknown as DurableObjectState, env);
    const instance = new Proxy(object, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]): Promise<unknown> => {
          await ready;
          return Reflect.apply(value, target, args);
        };
      },
    });
    instances.set(id.name, instance);
    return instance;
  }

  return {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get,
    /** Fires every alarm in this namespace whose time has passed. */
    async runDueAlarms() {
      let files: string[];
      try {
        files = readdirSync(dir).filter((file) => file.endsWith(".alarm"));
      } catch {
        return;
      }
      for (const file of files) {
        const name = decodeURIComponent(file.slice(0, -".alarm".length));
        const due = Number(readFileSync(path.join(dir, file), "utf8"));
        if (!(due <= Date.now())) continue;
        rmSync(path.join(dir, file), { force: true });
        try {
          await get({ name }).alarm?.();
        } catch (error) {
          console.error(
            `[durable-objects] ${binding} ${name} alarm failed:`,
            error,
          );
        }
      }
    },
  };
}
