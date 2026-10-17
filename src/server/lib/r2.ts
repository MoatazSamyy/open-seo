import { blobs } from "@/platform/runtime";

export async function getJsonFromR2(key: string): Promise<string> {
  const object = await blobs.get(key);
  if (!object) {
    throw new Error("Audit payload not found");
  }

  return object.text();
}

export async function putTextToR2(
  key: string,
  body: string,
): Promise<{ key: string; sizeBytes: number }> {
  await blobs.put(key, body, { contentType: "application/json" });

  return {
    key,
    sizeBytes: Buffer.byteLength(body),
  };
}
