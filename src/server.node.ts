import { env } from "cloudflare:workers";
import { withPgClient } from "@/db";
import { getAuthMode } from "@/lib/auth-mode";
import { waitUntil } from "@/platform/runtime";
import { appFetch } from "@/server/entry/app-fetch";
import { runFiveMinuteJobs } from "@/server/entry/scheduled-jobs";
import { maybeSendSelfHostHeartbeat } from "@/server/lib/self-host-telemetry";
import { MCP_ROUTE } from "@/server/mcp/context";
import { requestWithPublicOrigin } from "@/server/mcp/public-origin";
import { AiVisibilityWorkflow } from "@/server/workflows/AiVisibilityWorkflow";
import { RankCheckWorkflow } from "@/server/workflows/RankCheckWorkflow";
import { SiteAuditWorkflow } from "@/server/workflows/SiteAuditWorkflow";
import { startWorkflowRunner } from "@/platform/node/workflow-runner";

// Server entry for the Node runtime (fork milestone 3c; built by
// vite.node.config.ts, served by scripts/node-server.mjs). The Workers entry
// is src/server.ts. Workflows run on the Postgres runner (3d). Not here yet:
// site-audit crawl state (3e), SAM chat (3f), the operator GDPR erasure
// endpoint (needs Durable Object bindings), and hosted mode.

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

/** Runs the three workflows in this process; scripts/node-server.mjs calls it. */
export function startWorkflows() {
  startWorkflowRunner({
    workflows: {
      RANK_CHECK_WORKFLOW: RankCheckWorkflow,
      AI_VISIBILITY_WORKFLOW: AiVisibilityWorkflow,
      SITE_AUDIT_WORKFLOW: SiteAuditWorkflow,
    },
    env,
  });
}

/** The five-minute cron's work; scripts/node-server.mjs calls it on a timer. */
export function runScheduledJobs() {
  return runFiveMinuteJobs(env);
}
