import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";

// The TanStack Start app handler, shared by the Workers entry (src/server.ts)
// and the Node entry (src/server.node.ts).

const startHandler = createStartHandler(defaultStreamHandler);

// The app ships no security response headers of its own, so any third-party
// page can frame an app route and UI-redress a one-click action (delete a
// project, change project settings, buy credits). `frame-ancestors 'self'` on
// the app's own documents is the whole fix, and deliberately all of it: a
// script-src policy would need a nonce for the inline bootstrap script in
// __root.tsx plus allowances for Turnstile and PostHog, which is separate,
// larger work.
//
// Only HTML documents, and only ones that carry no policy of their own, so a
// route that sets its own stricter CSP keeps it (two CSP headers intersect, so
// adding a second could only confuse things). Wrapping the handler rather than
// one call site covers the OAuth-provider path too, which serves app documents
// through this same function.
export async function appFetch(request: Request): Promise<Response> {
  const response = await startHandler(request);
  const contentType = response.headers.get("content-type") ?? "";
  if (
    !contentType.startsWith("text/html") ||
    response.headers.has("content-security-policy")
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
