import { createFileRoute } from "@tanstack/react-router";
import { getConfig } from "@/platform/runtime";
import { getAuth, hasSessionAuthConfig } from "@/lib/auth";
import { isSessionAuthMode } from "@/lib/auth-mode";

async function handleAuthRequest(request: Request) {
  if (!isSessionAuthMode(getConfig("AUTH_MODE"))) {
    return new Response("Not found", {
      status: 404,
    });
  }

  if (!hasSessionAuthConfig()) {
    return new Response("Missing Better Auth sign-in configuration", {
      status: 500,
    });
  }

  const auth = getAuth();
  return auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        return handleAuthRequest(request);
      },
      POST: async ({ request }: { request: Request }) => {
        return handleAuthRequest(request);
      },
    },
  },
});
