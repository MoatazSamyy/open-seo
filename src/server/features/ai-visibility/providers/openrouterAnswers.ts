import { APICallError, generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { AppError } from "@/server/lib/errors";
import {
  getOptionalEnvValue,
  getRequiredEnvValue,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";
import type { AiEngine } from "@/shared/ai-visibility";
import { LOCATION_OPTIONS } from "@/shared/keyword-locations";
import { parseModelAnswer, type ParsedAiAnswer } from "./dataforseoEvidence";

// AI visibility answers straight from the models through OpenRouter, for
// self-hosters without a DataForSEO account. See
// docs/maintainers/specs/0025-openrouter-ai-visibility.md.

/**
 * A small current model per engine, with OpenRouter's web search on. Google
 * AI Overviews is a Google search feature, not a model, so it has none.
 */
const ENGINE_MODELS: Partial<Record<AiEngine, string>> = {
  chatgpt: "openai/gpt-6-luna",
  claude: "anthropic/claude-haiku-5.5",
  gemini: "google/gemini-3.8-flash",
  perplexity: "perplexity/sonar",
};

/** Matches the DataForSEO model path; reasoning models count hidden tokens. */
const MAX_OUTPUT_TOKENS = 4096;
const ANSWER_TIMEOUT_MS = 120_000;

/** Self-hosted only: these answers bypass hosted usage-credit metering. */
export async function usesOpenRouterAnswers(): Promise<boolean> {
  return (
    (await getOptionalEnvValue("AI_VISIBILITY_PROVIDER")) === "openrouter" &&
    !(await isHostedServerAuthMode())
  );
}

export function openRouterAnswersEngine(engine: AiEngine): boolean {
  return engine in ENGINE_MODELS;
}

/**
 * Asks one prompt the way a user would, with only the market as context, and
 * returns the answer with the pages its web search cited.
 */
export async function askOpenRouter(
  engine: AiEngine,
  prompt: string,
  locationCode: number,
): Promise<ParsedAiAnswer> {
  const modelId = ENGINE_MODELS[engine];
  if (!modelId)
    throw new AppError("VALIDATION_ERROR", `${engine} has no OpenRouter model`);
  const openrouter = createOpenRouter({
    apiKey: await getRequiredEnvValue("OPENROUTER_API_KEY"),
  });
  const country =
    LOCATION_OPTIONS.find((option) => option.code === locationCode)?.label ??
    "the United States";
  try {
    const result = await generateText({
      model: openrouter.chat(modelId, { plugins: [{ id: "web" }] }),
      system: `The user is in ${country}.`,
      prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });
    return parseModelAnswer(
      result.text,
      result.sources.flatMap((source) =>
        source.sourceType === "url"
          ? [{ url: source.url, title: source.title }]
          : [],
      ),
    );
  } catch (error) {
    const status = APICallError.isInstance(error) ? error.statusCode : null;
    throw new AppError(
      status === 429
        ? "RATE_LIMITED"
        : status === undefined || status === null || status >= 500
          ? "UPSTREAM_UNAVAILABLE"
          : "INTERNAL_ERROR",
      `OpenRouter answer failed: ${error instanceof Error ? error.message : String(error)}`,
      { provider: "openrouter", model: modelId },
    );
  }
}
