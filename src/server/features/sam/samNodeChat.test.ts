import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/db", () => ({
  db: testDb.db,
  withPgClient: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) =>
    name === "OPENROUTER_API_KEY" ? "test-key" : undefined,
}));
vi.mock("@/server/features/sam/samChatTools", () => ({
  buildSamMcpTools: () => ({}),
}));
const model = vi.hoisted(() => ({ fail: false }));

vi.mock("@/server/lib/openrouter", () => ({
  buildChatAgentModel: () =>
    new MockLanguageModelV3({
      doStream: async () => {
        if (model.fail) throw new Error("provider rejected the key");
        return {
          stream: convertArrayToReadableStream([
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Hi from SAM" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ]),
        };
      },
    }),
}));

import { SamSessionRepository } from "@/server/features/sam/SamSessionRepository";
import { handleSamNodeRequest } from "./samNodeChat";

let sessionId: string;

function userMessage(id: string, text: string) {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

async function chat(message: ReturnType<typeof userMessage>) {
  const response = await handleSamNodeRequest(
    new Request("https://seo.example.com/agents/sam-chat/x/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [message] }),
    }),
    sessionId,
    "chat",
  );
  // Drain the stream so the turn finishes and saves.
  await response.text();
}

async function transcript() {
  const response = await handleSamNodeRequest(
    new Request("https://seo.example.com/agents/sam-chat/x/get-messages"),
    sessionId,
    "get-messages",
  );
  const messages: Array<{ id: string; role: string }> = await response.json();
  return messages;
}

beforeEach(async () => {
  model.fail = false;
  await testDb.seedProject();
  await testDb.client.executeMultiple(`
    DELETE FROM user;
    INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES ('user', 'User', 'user@example.com', 1, 0, 0);
  `);
  ({ id: sessionId } = await SamSessionRepository.createSession({
    projectId: "project",
    userId: "user",
  }));
});

describe("SAM on Node", () => {
  it("stores the user message and SAM's streamed reply", async () => {
    await chat(userMessage("m1", "Which keywords should I target?"));

    const messages = await transcript();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(messages[1])).toContain("Hi from SAM");
    const session = await SamSessionRepository.getSessionById(sessionId);
    expect(session?.title).toBe("Which keywords should I target?");
  });

  it("rewinds the transcript from a message", async () => {
    await chat(userMessage("m1", "First question"));
    await chat(userMessage("m2", "Second question"));

    const rewind = await handleSamNodeRequest(
      new Request("https://seo.example.com/agents/sam-chat/x/rewind", {
        method: "POST",
        body: JSON.stringify({ messageId: "m2" }),
      }),
      sessionId,
      "rewind",
    );

    expect(rewind.status).toBe(200);
    expect((await transcript()).map((message) => message.id)).toEqual([
      "m1",
      expect.any(String),
    ]);
  });

  it("keeps the user's message but no empty reply when a turn fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    model.fail = true;

    await chat(userMessage("m1", "Hello"));

    expect((await transcript()).map((message) => message.id)).toEqual(["m1"]);
  });
});
