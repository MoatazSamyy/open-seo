import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { getOrCreateOrganizationCustomer } from "@/server/billing/subscription";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { SamSessionRepository } from "@/server/features/sam/SamSessionRepository";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

// Authorize a SAM chat request (Workers: before it reaches the SamChatAgent
// Durable Object; Node: before samNodeChat). The session id comes from the
// client; we resolve the session here and authorize the caller against the
// session's project via the same canonical project-access check the rest of
// the app uses, so the chat can trust the id and derive org/project/user from
// the session row. Returning a Response rejects; void lets it through.
export async function authorizeSamChat(
  request: Request,
  sessionId: string,
): Promise<Response | undefined> {
  let context;
  try {
    context = await resolveUserContextFromHeaders(request.headers);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const session = await SamSessionRepository.getActiveSession(
    sessionId,
    context.userId,
  );
  const project = session
    ? await ProjectRepository.getProjectForOrganization(
        session.projectId,
        context.organizationId,
      )
    : null;
  if (!session || !project) {
    return new Response("Forbidden", { status: 403 });
  }
  // Make sure the Autumn customer (and its default free-plan credits) exists
  // before the DO's balance gate runs, or a brand-new org's first message hits
  // a false "out of credits". Hosted-only; self-hosted has no Autumn.
  if (await isHostedServerAuthMode()) {
    await getOrCreateOrganizationCustomer(context);
  }
  return undefined;
}
