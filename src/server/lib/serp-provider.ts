import {
  fetchLiveSerp,
  fetchRankCheckSerp,
} from "@/server/lib/dataforseo/serp";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { fetchSerperLiveSerp, fetchSerperRankCheck } from "@/server/lib/serper";

// Routes live organic SERP calls to the operator's SERP provider. Only desktop
// organic SERPs have a second provider; mobile, Maps, Local Finder and queued
// SERPs always go to DataForSEO. See
// docs/maintainers/specs/0016-serp-provider-routing.md.

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

async function routesToSerper(device: "desktop" | "mobile" | undefined) {
  return (
    (device ?? "desktop") === "desktop" &&
    (await getSerpProvider()) === "serper"
  );
}

export async function fetchRoutedLiveSerp(
  input: Parameters<typeof fetchLiveSerp>[0],
) {
  return (await routesToSerper(input.device))
    ? fetchSerperLiveSerp(input)
    : fetchLiveSerp(input);
}

export async function fetchRoutedRankCheckSerp(
  input: Parameters<typeof fetchRankCheckSerp>[0],
) {
  return (await routesToSerper(input.device))
    ? fetchSerperRankCheck(input)
    : fetchRankCheckSerp(input);
}
