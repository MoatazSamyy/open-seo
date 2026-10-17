import { getConfig } from "@/platform/runtime";
import { createServerFn } from "@tanstack/react-start";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

export const getSeoApiKeyStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(() => {
    const configured = Boolean(getConfig("DATAFORSEO_API_KEY")?.trim());
    return { configured };
  });
