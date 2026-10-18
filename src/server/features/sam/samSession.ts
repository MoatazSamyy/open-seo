import type { UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { MCP_SCOPE } from "@/lib/oauth-resource";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { SamSessionRepository } from "@/server/features/sam/SamSessionRepository";
import { buildSamSystemPrompt } from "@/server/features/sam/samSystemPrompt";
import type { ToolAuthContext } from "@/server/mcp/context";

// What one SAM turn needs, shared by the Durable Object agent on Cloudflare
// (SamChatAgent) and the Node chat handler (samNodeChat), so the two SAMs
// can't drift on prompt, memory, tools, or limits.

export const SAM_PROJECT_CONTEXT_DESCRIPTION =
  "This project's shared memory — sections, competitors, key pages and research log, the same records the user sees in the app. Change it with update_project_context.";

// SAM runs complex multi-step work in one turn (site-read intake plus a full
// research chain, multi-competitor sweeps), so the step budget is generous;
// cost is bounded by per-step metering and the model stopping on its own. The
// per-step token budget is shared by max-effort reasoning and the visible
// reply, so it stays well above measured reasoning use (~3k tokens — a tight
// cap lets reasoning eat the reply, issue #161) but below the 32k that, with
// 48 steps, let a single turn outgrow the Durable Object memory limit.
export const SAM_MAX_STEPS = 40;
export const SAM_MAX_OUTPUT_TOKENS = 16_000;

export type SamContext = {
  row: NonNullable<
    Awaited<ReturnType<typeof SamSessionRepository.getSessionById>>
  >;
  project: NonNullable<
    Awaited<ReturnType<typeof ProjectRepository.getProjectById>>
  >;
  // The session row is normalized (project/user ids only); the creating
  // user's current email is resolved here for the billing/MCP auth context.
  userEmail: string;
};

/** The session row, its project, and its creator's email; null if any is gone. */
export async function loadSamContext(
  sessionId: string,
): Promise<SamContext | null> {
  const row = await SamSessionRepository.getSessionById(sessionId);
  if (!row) return null;
  const project = await ProjectRepository.getProjectById(row.projectId);
  if (!project) return null;
  const [creator] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, row.userId))
    .limit(1);
  if (!creator) return null;
  return { row, project, userEmail: creator.email };
}

/** SAM's identity prompt, in intake mode until the business is described. */
export async function buildSamSoulPrompt(
  ctx: SamContext | null,
): Promise<string> {
  if (!ctx) {
    return "You are SAM, the SEO agent inside OpenSEO. This chat session no longer exists; tell the user to start a new chat.";
  }
  const context = await ProjectContextService.getProjectContext(ctx.project.id);
  return buildSamSystemPrompt(
    {
      projectId: ctx.project.id,
      projectName: ctx.project.name,
      domain: ctx.project.domain,
      locationCode: ctx.project.locationCode,
      languageCode: ctx.project.languageCode,
    },
    // Nothing recorded about the business yet: SAM runs its intake flow.
    { intakeMode: context.missingSections.includes("business_overview") },
  );
}

/** The project's shared memory, rendered for the prompt. */
export async function renderSamProjectContext(
  ctx: SamContext | null,
): Promise<string | null> {
  if (!ctx) return null;
  return ProjectContextService.renderProjectContextMarkdown(
    await ProjectContextService.getProjectContext(ctx.project.id),
  );
}

/**
 * The MCP auth context SAM's tools run under, or null when the creator is no
 * longer a member in hosted mode. Delegated/self-host orgs have no member
 * rows, which makes the caller an implicit owner.
 */
export async function buildSamAuthContext(
  ctx: SamContext,
  options: { hosted: boolean; baseUrl: string },
): Promise<ToolAuthContext | null> {
  const membership = await AuthRepository.getMembership(
    ctx.row.userId,
    ctx.project.organizationId,
  );
  if (options.hosted && !membership) return null;
  return {
    userId: ctx.row.userId,
    userEmail: ctx.userEmail,
    organizationId: ctx.project.organizationId,
    role: membership?.role ?? "owner",
    // SAM sessions belong to one project's workspace; org context is fixed
    // for the session, like an OAuth token's.
    orgScope: "pinned",
    baseUrl: options.baseUrl,
    clientId: null,
    scopes: [MCP_SCOPE],
  };
}

/** Names the session from its first message, or refreshes its timestamp. */
export async function recordSamTurn(
  ctx: SamContext,
  messages: UIMessage[],
): Promise<void> {
  if (ctx.row.title === "New chat") {
    const title = deriveTitle(firstUserText(messages));
    if (title !== "New chat") {
      await SamSessionRepository.setTitle(ctx.row.id, title);
      ctx.row.title = title;
    }
  } else {
    await SamSessionRepository.touch(ctx.row.id);
  }
}

// Derive a short session title from the first user message.
function deriveTitle(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "New chat";
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

function firstUserText(messages: UIMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const textPart = firstUser?.parts.find((part) => part.type === "text");
  return textPart?.text ?? "";
}
