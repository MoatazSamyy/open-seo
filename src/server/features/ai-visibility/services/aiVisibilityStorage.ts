import type { BlobStore, StoredBlob } from "@/platform/runtime";

/** Generated exports are private project data. */
export async function deleteProjectAiObjects(
  bucket: BlobStore,
  projectId: string,
) {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list({
      prefix: `ai-visibility/${projectId}/`,
      cursor,
    });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    deleted += keys.length;
    cursor = page.cursor;
  } while (cursor);
  return deleted;
}

/** Exports carry their expiry; anything without one is stale. */
export function aiObjectHasExpired(
  object: Pick<StoredBlob, "customMetadata">,
  now: number,
) {
  const expiry = Date.parse(object.customMetadata.expiresAt ?? "");
  return !Number.isFinite(expiry) || now >= expiry;
}
