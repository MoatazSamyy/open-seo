import type { AiBrand } from "@/shared/ai-visibility";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import type { ParsedAiAnswer } from "../providers/dataforseoEvidence";
import { aiBrands } from "./aiVisibilityConfiguration";
import { matchAiBrand } from "./aiVisibilityMatching";

// Shared by every answer provider's collection step.

/** Brands come from the project as each answer is matched. */
export async function runBrands(runId: string) {
  const run = await repo.getRunInternal(runId);
  const project = run ? await repo.getProject(run.projectId) : null;
  if (!run || !project) return null;
  return aiBrands(project, await repo.listCompetitors(project.id));
}

/** Saves one answer with its citations and brand results. */
export async function saveAiAnswer(
  observationId: string,
  answer: ParsedAiAnswer,
  brands: AiBrand[],
) {
  await repo.persistAnswer({
    observationId,
    values: {
      status: "completed",
      collectedAt: answer.collectedAt ?? new Date().toISOString(),
      answerMarkdown: answer.answerMarkdown,
      error: null,
    },
    sources: answer.citations.map((citation) => ({
      id: crypto.randomUUID(),
      observationId,
      ...citation,
    })),
    matches: brands.map((brand) => ({
      id: crypto.randomUUID(),
      observationId,
      ...brand,
      ...matchAiBrand(answer, brand),
    })),
  });
}
