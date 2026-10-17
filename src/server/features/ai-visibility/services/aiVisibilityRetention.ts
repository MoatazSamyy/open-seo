import { blobs, kv } from "@/platform/runtime";
import { pruneAiHistory } from "../repositories/aiVisibilityRetentionRepository";
import { aiObjectHasExpired } from "./aiVisibilityStorage";

const CURSOR_KEY = "ai-visibility:retention-cursor";

/** One bounded sweep page of expired exports per scheduler tick. */
export async function pruneAiVisibility() {
  const now = new Date();
  await pruneAiHistory(now);
  const cursor = await kv.get(CURSOR_KEY);
  const page = await blobs.list({
    prefix: "ai-visibility/",
    cursor: cursor ?? undefined,
    limit: 500,
  });
  const expired = page.objects
    .filter((object) => aiObjectHasExpired(object, now.getTime()))
    .map((object) => object.key);
  if (expired.length) await blobs.delete(expired);
  if (page.cursor) await kv.put(CURSOR_KEY, page.cursor);
  else await kv.delete(CURSOR_KEY);
}
