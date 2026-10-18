import type { UIMessage } from "ai";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { samNodeMessages } from "@/db/schema";

// SAM transcripts on the Node runtime, one row per UIMessage in order. On
// Cloudflare the SamChatAgent Durable Object stores them instead.

async function listMessages(sessionId: string): Promise<UIMessage[]> {
  const rows = await db
    .select({ message: samNodeMessages.message })
    .from(samNodeMessages)
    .where(eq(samNodeMessages.sessionId, sessionId))
    .orderBy(asc(samNodeMessages.position));
  return rows.map((row) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rows are UIMessages this repository wrote
    return JSON.parse(row.message) as UIMessage;
  });
}

/** Replace the transcript with `messages`, in one atomic write. */
async function saveMessages(
  sessionId: string,
  messages: UIMessage[],
): Promise<void> {
  await runBatch((tx) => [
    tx.delete(samNodeMessages).where(eq(samNodeMessages.sessionId, sessionId)),
    ...(messages.length > 0
      ? [
          tx.insert(samNodeMessages).values(
            messages.map((message, position) => ({
              id: `${sessionId}:${message.id}`,
              sessionId,
              position,
              message: JSON.stringify(message),
            })),
          ),
        ]
      : []),
  ]);
}

/**
 * Delete `messageId` and everything after it. Returns false when the message
 * isn't in this session's transcript.
 */
async function deleteFromMessage(
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ position: samNodeMessages.position })
    .from(samNodeMessages)
    .where(eq(samNodeMessages.id, `${sessionId}:${messageId}`))
    .limit(1);
  if (!row) return false;
  await db
    .delete(samNodeMessages)
    .where(
      and(
        eq(samNodeMessages.sessionId, sessionId),
        gte(samNodeMessages.position, row.position),
      ),
    );
  return true;
}

export const SamNodeMessageRepository = {
  listMessages,
  saveMessages,
  deleteFromMessage,
} as const;
