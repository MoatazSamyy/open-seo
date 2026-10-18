import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, expect, it, vi } from "vitest";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { collectAiModelBatch, prepareAiRun } from "./aiVisibilityCollection";
import { configuration, customer } from "./aiVisibilityTestFixtures";

const { testDb, chat } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb(), chat: vi.fn() };
});
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => false,
  getOptionalEnvValue: async (name: string) =>
    name === "AI_VISIBILITY_PROVIDER" ? "openrouter" : undefined,
  getRequiredEnvValue: async () => "test-key",
}));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => ({ chat }),
}));

const runId = "run";
const market = { locationCode: 2818, languageCode: "ar" };

beforeEach(async () => {
  chat.mockReturnValue(
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          { type: "text", text: "Try OpenSEO." },
          {
            type: "source",
            sourceType: "url",
            id: "s1",
            url: "https://openseo.so/?utm_source=x",
            title: "OpenSEO",
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    }),
  );
  await testDb.seedProject();
  const rows = configuration({
    engines: ["chatgpt", "google_ai_overview"],
    prompts: [{ text: "Which SEO tools?" }],
  });
  await repo.saveConfiguration(rows);
  await repo.createRun(
    {
      id: runId,
      trackerId: rows.tracker.id,
      projectId: "project",
      trigger: "scheduled",
      status: "queued",
      ...market,
      createdAt: "2026-10-18T12:00:00.000Z",
    },
    (["chatgpt", "google_ai_overview"] as const).map((engine) => ({
      id: `answer-${engine}`,
      runId,
      promptId: rows.prompts[0].id,
      engine,
      branded: false,
    })),
  );
});

it("asks every engine through OpenRouter with web search and saves cited answers", async () => {
  const plan = await prepareAiRun(runId);
  expect(plan.batches).toEqual([]);

  for (const batch of plan.modelBatches)
    await collectAiModelBatch(runId, customer, plan.market, batch);

  expect(chat).toHaveBeenCalledWith("openai/gpt-6-luna", {
    plugins: [{ id: "web" }],
  });
  expect(await repo.getObservation("answer-chatgpt")).toMatchObject({
    status: "completed",
    answerMarkdown: "Try OpenSEO.",
  });
  expect((await repo.getEvidence(["answer-chatgpt"])).sources).toMatchObject([
    { url: "https://openseo.so/", domain: "openseo.so" },
  ]);
  // AI Overviews is a Google search feature with no model to ask.
  expect(await repo.getObservation("answer-google_ai_overview")).toMatchObject({
    status: "failed",
  });
});
