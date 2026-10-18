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
import { registerBinding } from "@/platform/node/cloudflare-workers";
import { createDurableObjectNamespace } from "@/platform/node/durable-objects";
import { AuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import AuditEngine from "@/audit-worker";
import { authorizeSamChat } from "@/server/features/sam/samChatAccess";
import { handleSamNodeRequest } from "@/server/features/sam/samNodeChat";

// Server entry for the Node runtime (fork milestone 3c; built by
// vite.node.config.ts, served by scripts/node-server.mjs). The Workers entry
// is src/server.ts. Workflows run on the Postgres runner (3d), site audits'
// crawl scratchpad and audit engine run in this process (3e), and SAM chat
// runs over HTTP (3f). Not here yet: the operator GDPR erasure endpoint and
// hosted mode.

const nodeExecutionContext = {
  waitUntil,
  passThroughOnException: () => undefined,
  props: {},
};

// Bindings the site-audit workflow reaches through cloudflare:workers, which
// on Cloudflare live in the separate audit worker (src/audit-worker.ts).
const auditScratchpads = createDurableObjectNamespace(
  "AUDIT_SCRATCHPAD",
  AuditScratchpad,
  env,
);
registerBinding("AUDIT_SCRATCHPAD", auditScratchpads);
registerBinding("AUDIT_ENGINE", new AuditEngine(nodeExecutionContext, env));

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

  // SAM chat over HTTP: /agents/sam-chat/<sessionId>/<action>, the same
  // paths the Workers agent serves (spec 0023).
  const samRoute = /^\/agents\/sam-chat\/([^/]+)\/([a-z-]+)$/.exec(pathname);
  if (samRoute) {
    const [, sessionId, action] = samRoute;
    const denied = await authorizeSamChat(publicRequest, sessionId);
    if (denied) return denied;
    return handleSamNodeRequest(publicRequest, sessionId, action);
  }
  if (pathname.startsWith("/agents/")) {
    return new Response("Not found", { status: 404 });
  }

  if (
    pathname === MCP_ROUTE &&
    (authMode === "cloudflare_access" || authMode === "local_noauth")
  ) {
    const { handleSelfHostedOpenSeoMcpRequest } =
      await import("@/server/mcp/transport");
    return handleSelfHostedOpenSeoMcpRequest(
      publicRequest,
      authMode,
      env,
      nodeExecutionContext,
    );
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
export async function runScheduledJobs() {
  // Workers fires Durable Object alarms itself; on Node the cron does.
  await auditScratchpads.runDueAlarms();
  await runFiveMinuteJobs(env);
}
