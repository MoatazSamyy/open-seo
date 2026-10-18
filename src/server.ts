import { routeAgentRequest } from "agents";
import { appFetch } from "@/server/entry/app-fetch";
import { authorizeSamChat } from "@/server/features/sam/samChatAccess";
import { runFiveMinuteJobs } from "@/server/entry/scheduled-jobs";
import { getAuthMode, isHostedAuthMode } from "@/lib/auth-mode";
import {
  createOpenSeoOAuthProvider,
  type OpenSeoOAuthEnv,
} from "@/server/mcp/oauth-provider";
import { requestWithPublicOrigin } from "@/server/mcp/public-origin";
import { MCP_ROUTE } from "@/server/mcp/context";
import { withPgClient } from "@/db";
import {
  AUTUMN_WEBHOOK_PATH,
  handleAutumnWebhookRequest,
} from "@/server/billing/autumn-webhook";
import { sweepDubReferredOrganizations } from "@/server/referrals/dub";
import { maybeSendSelfHostHeartbeat } from "@/server/lib/self-host-telemetry";
import { handleGdprStorageErasure } from "@/server/gdpr/storage-erasure";
import { GDPR_STORAGE_ERASURE_PATH } from "@/shared/gdpr-erasure";

const openSeoOAuthProvider = createOpenSeoOAuthProvider(appFetch);

// The chat DO lives behind /agents/*. Dispatch on the DO binding partyserver
// resolved for the request (rather than re-parsing the path), and fail closed
// on anything unrecognized.
function authorizeChatAgent(
  request: Request,
  lobby: { className: string; name: string },
): Promise<Response | undefined> | Response {
  if (lobby.className === "SAM_CHAT") {
    return authorizeSamChat(request, lobby.name);
  }
  return new Response("Forbidden", { status: 403 });
}

// Route /agents/* to the SAM chat DO. Auth happens here (both the WS upgrade
// and any HTTP message-history fetch), keeping it off the OAuth wrapper and
// TanStack route guard below.
async function routeChatAgents(request: Request, env: Env): Promise<Response> {
  const response = await routeAgentRequest(request, env, {
    onBeforeConnect: (req, lobby) => authorizeChatAgent(req, lobby),
    onBeforeRequest: (req, lobby) => authorizeChatAgent(req, lobby),
  });
  return response ?? new Response("Not found", { status: 404 });
}

function fetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Scope a per-request Postgres client (no-op in D1 mode). The client isn't
  // closed here — the Workers↔Hyperdrive socket is reclaimed at invocation end.
  return withPgClient(() => Promise.resolve(handleFetch(request, env, ctx)));
}

function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Response | Promise<Response> {
  const authMode = getAuthMode(env.AUTH_MODE);
  const publicRequest = requestWithPublicOrigin(request);
  const pathname = new URL(publicRequest.url).pathname;
  ctx.waitUntil(maybeSendSelfHostHeartbeat(pathname));

  if (pathname === "/api/ai-visibility/download") {
    return import("@/server/features/ai-visibility/services/aiVisibilityExport").then(
      ({ handleAiVisibilityDownload }) =>
        handleAiVisibilityDownload(publicRequest),
    );
  }

  if (pathname === GDPR_STORAGE_ERASURE_PATH) {
    return handleGdprStorageErasure(publicRequest, env);
  }

  if (pathname.startsWith("/agents/")) {
    return routeChatAgents(publicRequest, env);
  }

  if (isHostedAuthMode(authMode)) {
    if (pathname === AUTUMN_WEBHOOK_PATH) {
      return handleAutumnWebhookRequest(publicRequest);
    }

    return openSeoOAuthProvider.fetch(
      publicRequest,
      env as OpenSeoOAuthEnv,
      ctx,
    );
  }

  if (
    (authMode === "cloudflare_access" || authMode === "local_noauth") &&
    pathname === MCP_ROUTE
  ) {
    return import("@/server/mcp/transport").then(
      ({ handleSelfHostedOpenSeoMcpRequest }) =>
        handleSelfHostedOpenSeoMcpRequest(publicRequest, authMode, env, ctx),
    );
  }

  return appFetch(request);
}

// Export Workflow classes as named exports. SiteAuditWorkflow and the
// AuditScratchpad DO live in the open-seo-audit aux worker
// (src/audit-worker.ts); this worker reaches them via cross-script bindings.
export { RankCheckWorkflow } from "./server/workflows/RankCheckWorkflow";
export { AiVisibilityWorkflow } from "./server/workflows/AiVisibilityWorkflow";
// Durable Object class for the SAM in-app agent (Agents SDK).
export { SamChatAgent } from "./server/features/sam/SamChatAgent";

// Daily OAuth KV garbage collection; must match a trigger in wrangler.jsonc.
const MCP_OAUTH_PURGE_CRON = "17 3 * * *";

export default {
  fetch,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    if (controller.cron === MCP_OAUTH_PURGE_CRON) {
      // Only hosted mode runs the OAuth provider (and has OAUTH_KV bound).
      if (isHostedAuthMode(getAuthMode(env.AUTH_MODE))) {
        const result = await openSeoOAuthProvider.purgeExpiredData(
          env as OpenSeoOAuthEnv,
        );
        console.log("[mcp-oauth] purged expired OAuth data", result);
        if (!result.done) {
          // The sweep only advances past live records via deletions; a
          // persistent incomplete scan means the keyspace outgrew the batch.
          console.warn("[mcp-oauth] purge did not cover the full keyspace");
        }

        // Daily referral-sale sweep: catches paid Autumn invoices the
        // billing.updated webhook path misses (renewals, one-time top-ups).
        try {
          await sweepDubReferredOrganizations();
        } catch (err) {
          console.error("[cron] Dub referral sale sweep failed:", err);
        }
      }
      return;
    }

    await runFiveMinuteJobs(env);
  },
};
