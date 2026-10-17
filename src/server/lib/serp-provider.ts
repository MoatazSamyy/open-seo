import {
  DataforseoChargedTaskError,
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import {
  fetchLiveSerp,
  fetchRankCheckSerp,
} from "@/server/lib/dataforseo/serp";
import { AppError } from "@/server/lib/errors";
import {
  runWithFailover,
  type ProviderAttempt,
} from "@/server/lib/provider-failover";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { fetchSerperLiveSerp, fetchSerperRankCheck } from "@/server/lib/serper";

// Routes live organic SERP calls to the operator's SERP provider, falling over
// to the other one when both are configured. Only desktop organic SERPs have a
// second provider; mobile, Maps, Local Finder and queued SERPs always go to
// DataForSEO. See docs/maintainers/specs/0016-serp-provider-routing.md and
// 0018-provider-failover.md.

type SerpProvider = "dataforseo" | "serper";

async function getSerpProvider(): Promise<SerpProvider> {
  const configured = (await getOptionalEnvValue("SERP_PROVIDER"))
    ?.trim()
    .toLowerCase();
  if (!configured || configured === "dataforseo") return "dataforseo";
  if (configured === "serper") {
    if (await getOptionalEnvValue("SERPER_API_KEY")) return "serper";
    console.warn(
      "serp-provider: SERP_PROVIDER=serper but SERPER_API_KEY is not set; using DataForSEO",
    );
    return "dataforseo";
  }
  console.warn(
    `serp-provider: unknown SERP_PROVIDER "${configured}"; using DataForSEO`,
  );
  return "dataforseo";
}

/**
 * Scheduled rank checks use DataForSEO's cheaper task queue. Serper has no
 * queue and answers in seconds, so under Serper they run live like manual
 * checks.
 */
export async function getRankCheckMethod(
  trigger: "manual" | "scheduled",
): Promise<"live" | "queued"> {
  if (trigger === "manual") return "live";
  return (await getSerpProvider()) === "serper" ? "live" : "queued";
}

/**
 * The providers to try for one SERP, primary first. Serper only serves
 * desktop SERPs, and each provider is offered only when its key is set, so a
 * failover never ends on a "missing key" error instead of the real failure.
 */
async function serpAttempts<T>(
  device: "desktop" | "mobile" | undefined,
  fromDataforseo: () => Promise<DataforseoApiResponse<T>>,
  fromSerper: () => Promise<DataforseoApiResponse<T>>,
): Promise<ProviderAttempt<DataforseoApiResponse<T>>[]> {
  const dataforseo = { provider: "dataforseo" as const, run: fromDataforseo };
  const serper = { provider: "serper" as const, run: fromSerper };
  const serperAvailable =
    (device ?? "desktop") === "desktop" &&
    Boolean(await getOptionalEnvValue("SERPER_API_KEY"));
  if (!serperAvailable) return [dataforseo];
  const dataforseoAvailable = Boolean(
    await getOptionalEnvValue("DATAFORSEO_API_KEY"),
  );
  if ((await getSerpProvider()) === "serper") {
    return dataforseoAvailable ? [serper, dataforseo] : [serper];
  }
  return [dataforseo, serper];
}

/**
 * runWithFailover for billed SERP calls. A failed attempt can still have been
 * charged (DataforseoChargedTaskError), so its cost is added to the answer's
 * billing, or carried on the final error, for the meter to charge.
 */
async function fetchSerpWithFailover<T>(
  label: string,
  attempts: ProviderAttempt<DataforseoApiResponse<T>>[],
): Promise<DataforseoApiResponse<T>> {
  const charged: DataforseoApiCallCost[] = [];
  const tracked = attempts.map((attempt) => ({
    provider: attempt.provider,
    run: async () => {
      try {
        return await attempt.run();
      } catch (error) {
        if (error instanceof DataforseoChargedTaskError) {
          charged.push(error.billing);
        }
        throw error;
      }
    },
  }));
  const chargedUsd = () => charged.reduce((sum, cost) => sum + cost.costUsd, 0);

  try {
    const result = await runWithFailover(label, tracked);
    if (charged.length === 0) return result;
    return {
      ...result,
      billing: {
        ...result.billing,
        costUsd: result.billing.costUsd + chargedUsd(),
      },
    };
  } catch (error) {
    const ownUsd =
      error instanceof DataforseoChargedTaskError ? error.billing.costUsd : 0;
    if (charged.length === 0 || chargedUsd() === ownUsd) throw error;
    throw new DataforseoChargedTaskError(
      error instanceof Error ? error.message : String(error),
      { path: charged[0].path, costUsd: chargedUsd() },
      false,
      error instanceof AppError ? error.code : "UPSTREAM_UNAVAILABLE",
    );
  }
}

export async function fetchRoutedLiveSerp(
  input: Parameters<typeof fetchLiveSerp>[0],
) {
  return fetchSerpWithFailover(
    "live-serp",
    await serpAttempts(
      input.device,
      () => fetchLiveSerp(input),
      () => fetchSerperLiveSerp(input),
    ),
  );
}

export async function fetchRoutedRankCheckSerp(
  input: Parameters<typeof fetchRankCheckSerp>[0],
) {
  return fetchSerpWithFailover(
    "rank-check",
    await serpAttempts(
      input.device,
      () => fetchRankCheckSerp(input),
      () => fetchSerperRankCheck(input),
    ),
  );
}
