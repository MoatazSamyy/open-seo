import { env } from "cloudflare:workers";
import { withPgClient } from "@/db";
import { getAuthMode } from "@/lib/auth-mode";
import { waitUntil } from "@/platform/runtime";
import { appFetch } from "@/server/entry/app-fetch";
import { runFiveMinuteJobs } from "@/server/entry/scheduled-jobs";
import { maybeSendSelfHostHeartbeat } from "@/server/lib/self-host-telemetry";
import { MCP_ROUTE } from "@/server/mcp/context";
import { requestWithPublicOrigin } from "@/server/mcp/public-origin";

// Server entry for the Node runtime (fork milestone 3c; built by
// vite.node.config.ts, served by scripts/node-server.mjs). The Workers entry
// is src/server.ts. Not here yet: SAM chat (3f), the operator GDPR erasure
// endpoint (needs Workflow and Durable Object bindings), and hosted mode.

async function handleRequest(request: Request): Promise<Response> {
  const authMode = getAuthMode(env.AUTH_MODE);
  if (authMode === "hosted") {
    return new Response(
      "AUTH_MODE=hosted isn't supported on the Node runtime.",
      {
        status: 501,
      },
    );
  }

  const publicRequest = requestWithPublicOrigin(request);
  const pathname = new URL(publicRequest.url).pathname;
  waitUntil(maybeSendSelfHostHeartbeat(pathname));

  if (pathname === "/api/ai-visibility/download") {
    const { handleAiVisibilityDownload } =
      await import("@/server/features/ai-visibility/services/aiVisibilityExport");
    return handleAiVisibilityDownload(publicRequest);
  }

  if (pathname.startsWith("/agents/")) {
    return new Response("SAM chat isn't available on the Node runtime yet.", {
      status: 404,
    });
  }

  if (
    pathname === MCP_ROUTE &&
    (authMode === "cloudflare_access" || authMode === "local_noauth")
  ) {
    const { handleSelfHostedOpenSeoMcpRequest } =
      await import("@/server/mcp/transport");
    return handleSelfHostedOpenSeoMcpRequest(publicRequest, authMode, env, {
      waitUntil,
      passThroughOnException: () => undefined,
      props: {},
    });
  }

  return appFetch(request);
}

export default {
  fetch: (request: Request) => withPgClient(() => handleRequest(request)),
};

/** The five-minute cron's work; scripts/node-server.mjs calls it on a timer. */
export function runScheduledJobs() {
  return runFiveMinuteJobs(env);
}
