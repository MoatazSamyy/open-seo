import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  validateUIMessages,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { withPgClient } from "@/db";
import { staticAssistantModel } from "@/server/lib/chatAgent";
import { buildChatAgentModel } from "@/server/lib/openrouter";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import { SamNodeMessageRepository as messages } from "@/server/features/sam/SamNodeMessageRepository";
import { buildSamSkillSource } from "@/server/features/sam/samSkills";
import {
  buildSamAuthContext,
  buildSamSoulPrompt,
  loadSamContext,
  recordSamTurn,
  renderSamProjectContext,
  SAM_MAX_OUTPUT_TOKENS,
  SAM_MAX_STEPS,
  SAM_PROJECT_CONTEXT_DESCRIPTION,
} from "@/server/features/sam/samSession";

// SAM on the Node runtime (fork milestone 3f), where there are no Durable
// Objects for the Agents SDK. Same prompt, project memory, tools, skills, and
// limits as SamChatAgent (shared through samSession.ts), streamed over plain
// HTTP with the AI SDK and stored in sam_node_messages. It serves the same
// /agents/sam-chat/<session>/... paths the Workers agent does, so the client
// changes only its transport. See docs/maintainers/specs/0023-node-sam.md.
//
// Not carried over: billing (Node never runs hosted mode), between-turn
// compaction (older tool calls are pruned from the prompt instead), and
// recovery of a turn the process died during.

// Older tool calls drop out of the prompt (their results are often large
// tables); the model keeps the conversation and the recent tool work.
const KEEP_TOOL_CALLS = "before-last-4-messages";

// The in-flight turn per session, so a rewind can stop it before deleting.
const activeTurns = new Map<string, AbortController>();

const chatBodySchema = z.object({ messages: z.array(z.unknown()).min(1) });

/** Handles GET get-messages, POST rewind, and POST chat for one session. */
export async function handleSamNodeRequest(
  request: Request,
  sessionId: string,
  action: string,
): Promise<Response> {
  if (request.method === "GET" && action === "get-messages") {
    return Response.json(await messages.listMessages(sessionId));
  }
  if (request.method === "POST" && action === "rewind") {
    const body = z
      .object({ messageId: z.string().min(1) })
      .safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return Response.json({ error: "messageId required" }, { status: 400 });
    }
    activeTurns.get(sessionId)?.abort();
    const found = await messages.deleteFromMessage(
      sessionId,
      body.data.messageId,
    );
    return found
      ? Response.json({ ok: true })
      : Response.json({ error: "message not found" }, { status: 404 });
  }
  if (request.method === "POST" && action === "chat") {
    return runTurn(request, sessionId);
  }
  return new Response("Not found", { status: 404 });
}

async function runTurn(request: Request, sessionId: string) {
  const body = chatBodySchema.safeParse(await request.json().catch(() => null));
  let latest: UIMessage | undefined;
  try {
    [latest] = body.success
      ? await validateUIMessages({ messages: [body.data.messages.at(-1)] })
      : [];
  } catch {
    latest = undefined;
  }
  if (latest?.role !== "user") {
    return Response.json(
      { error: "a user message is required" },
      { status: 400 },
    );
  }

  // The stored transcript is the history; the client only adds its new
  // message (or resends the last one).
  const stored = await messages.listMessages(sessionId);
  const history = stored.some((message) => message.id === latest.id)
    ? stored
    : [...stored, latest];
  await messages.saveMessages(sessionId, history);

  activeTurns.get(sessionId)?.abort();
  const controller = new AbortController();
  activeTurns.set(sessionId, controller);

  const ctx = await loadSamContext(sessionId);
  const apiKey = await getOptionalEnvValue("OPENROUTER_API_KEY");
  const authContext =
    ctx &&
    (await buildSamAuthContext(ctx, {
      hosted: false,
      baseUrl: getPublicOrigin(request),
    }));
  const refusal = !ctx
    ? "I couldn't find this chat session. Please start a new one."
    : !apiKey
      ? "SAM needs OPENROUTER_API_KEY on this server. Add it to your environment and restart OpenSEO."
      : !authContext
        ? "You no longer have access to this organization, so I can't continue this chat."
        : null;

  const turnSettings =
    refusal || !ctx || !apiKey || !authContext
      ? { model: staticAssistantModel(refusal ?? "Something went wrong.") }
      : {
          model: buildChatAgentModel(
            apiKey,
            await getOptionalEnvValue("OPENROUTER_MODEL"),
            "max",
          ),
          system: await buildSystemPrompt(ctx),
          tools: {
            ...(
              await import("@/server/features/sam/samChatTools")
            ).buildSamMcpTools(authContext, ctx.project, crypto.randomUUID()),
            load_skill: loadSkillTool(),
          },
        };

  const result = streamText({
    ...turnSettings,
    messages: pruneMessages({
      messages: await convertToModelMessages(history),
      toolCalls: KEEP_TOOL_CALLS,
    }),
    stopWhen: stepCountIs(SAM_MAX_STEPS),
    maxOutputTokens: SAM_MAX_OUTPUT_TOKENS,
    abortSignal: controller.signal,
  });

  return result.toUIMessageStreamResponse({
    originalMessages: history,
    // Without this the AI SDK leaves reply ids empty, and stored replies
    // would collide.
    generateMessageId: () => crypto.randomUUID(),
    onFinish: async ({ messages: transcript }) => {
      if (activeTurns.get(sessionId) === controller) {
        activeTurns.delete(sessionId);
      }
      // A rewind stopped this turn and deleted what it would have answered.
      if (controller.signal.aborted) return;
      // A failed turn leaves an empty assistant message; storing it would
      // make the whole transcript fail validation when it's loaded back.
      const kept = transcript.filter((message) => message.parts.length > 0);
      await withPgClient(async () => {
        await messages.saveMessages(sessionId, kept);
        if (ctx) await recordSamTurn(ctx, kept);
      });
    },
    onError: (error) => {
      console.error("[sam] chat turn error", error);
      return "Something went wrong. Try again.";
    },
  });
}

async function buildSystemPrompt(
  ctx: NonNullable<Awaited<ReturnType<typeof loadSamContext>>>,
) {
  const [soul, projectContext, skills] = await Promise.all([
    buildSamSoulPrompt(ctx),
    renderSamProjectContext(ctx),
    buildSamSkillSource().list(),
  ]);
  return [
    soul,
    `## project_context\n${SAM_PROJECT_CONTEXT_DESCRIPTION}\n\n${projectContext ?? "(empty)"}`,
    `## Skills\nWhen a request matches one of these workflows, call load_skill with its name and follow it.\n${skills
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join("\n")}`,
  ].join("\n\n");
}

function loadSkillTool() {
  return tool({
    description:
      "Load the full instructions for one of the skills listed in the system prompt.",
    inputSchema: z.object({ name: z.string().min(1) }),
    execute: async ({ name }) => {
      const skill = await buildSamSkillSource().load(name);
      return skill ? skill.body : `No skill named "${name}".`;
    },
  });
}
