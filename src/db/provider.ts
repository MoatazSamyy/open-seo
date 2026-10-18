import { getConfigByName, getPostgresUrl } from "@/platform/runtime";

type DatabaseProvider = "d1" | "postgres";

export function getDatabaseProvider(): DatabaseProvider {
  const provider = getConfigByName("DATABASE_PROVIDER");

  if (provider === "postgres") {
    return "postgres";
  }

  if (provider === "d1" || provider === undefined) {
    return "d1";
  }

  throw new Error(
    `Unsupported DATABASE_PROVIDER "${provider}". Expected "d1" or "postgres".`,
  );
}

// The runtime decides where the connection string comes from: on Workers only
// the HYPERDRIVE binding (in local dev, its localConnectionString), on Node the
// POSTGRES_DATABASE_URL setting.
export function getPostgresConnectionString() {
  const url = getPostgresUrl();
  if (url) {
    return url;
  }

  throw new Error(
    "DATABASE_PROVIDER=postgres requires a HYPERDRIVE binding on Workers (in local dev, its localConnectionString) or POSTGRES_DATABASE_URL on Node.",
  );
}
