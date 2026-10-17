import { AppError } from "@/server/lib/errors";
import type { ErrorCode } from "@/shared/error-codes";

// Failover between SEO data providers. See
// docs/maintainers/specs/0018-provider-failover.md.

type DataProvider = "dataforseo" | "serper" | "keywords_everywhere";

export type ProviderAttempt<T> = {
  provider: DataProvider;
  run: () => Promise<T>;
};

/**
 * Failures on the provider's side or with the operator's provider account.
 * Anything else (bad input, the customer's own credits) would fail the same
 * way on every provider, so it is rethrown without trying the next one.
 */
const FAILOVER_ERROR_CODES = new Set<ErrorCode>([
  "UPSTREAM_UNAVAILABLE",
  "RATE_LIMITED",
  "DATAFORSEO_AUTH_FAILED",
]);

function isFailoverError(error: unknown): error is AppError {
  return error instanceof AppError && FAILOVER_ERROR_CODES.has(error.code);
}

const COOLDOWN_MS = 60_000;

// Per isolate: a provider that just failed is tried last for a minute, so a
// hard outage doesn't put a failed call in front of every request.
const cooldownUntil = new Map<DataProvider, number>();

function isCoolingDown(provider: DataProvider, now: number): boolean {
  return (cooldownUntil.get(provider) ?? 0) > now;
}

/**
 * Runs the attempts in order until one succeeds, moving on only when a
 * provider fails on its own side. Providers cooling down after a recent
 * failure go last, keeping the configured order otherwise. Rethrows the last
 * provider's error when every attempt fails.
 */
export async function runWithFailover<T>(
  label: string,
  attempts: ProviderAttempt<T>[],
): Promise<T> {
  const now = Date.now();
  const ordered = [
    ...attempts.filter((attempt) => !isCoolingDown(attempt.provider, now)),
    ...attempts.filter((attempt) => isCoolingDown(attempt.provider, now)),
  ];

  for (let index = 0; ; index++) {
    const attempt = ordered[index];
    try {
      const result = await attempt.run();
      if (index > 0) {
        console.warn(
          `provider-failover: ${label} answered by ${attempt.provider} after ${ordered[index - 1].provider} failed`,
        );
      }
      return result;
    } catch (error) {
      if (!isFailoverError(error)) throw error;
      cooldownUntil.set(attempt.provider, Date.now() + COOLDOWN_MS);
      const next = ordered[index + 1];
      if (!next) throw error;
      console.warn(
        `provider-failover: ${label} ${attempt.provider} failed (${error.code}); trying ${next.provider}`,
      );
    }
  }
}
