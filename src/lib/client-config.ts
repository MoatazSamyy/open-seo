import { createIsomorphicFn } from "@tanstack/react-start";

// Settings the browser needs, read from the server's runtime env and written
// into the page (see __root.tsx) instead of being baked into the client build.
// That lets one prebuilt image serve any configuration. See
// docs/maintainers/fork-roadmap.md, milestone 3a.

const CLIENT_CONFIG_KEYS = [
  "AUTH_MODE",
  "BYPASS_EMAIL_VERIFICATION",
  "POSTHOG_PUBLIC_KEY",
  "POSTHOG_HOST",
  "TURNSTILE_SITE_KEY",
] as const;

type ClientConfig = Partial<
  Record<(typeof CLIENT_CONFIG_KEYS)[number], string>
>;

declare global {
  interface Window {
    __OPENSEO_CONFIG__?: ClientConfig;
  }
}

/**
 * On the server, the runtime env (workerd populates process.env from the
 * Worker's vars and secrets under nodejs_compat). In the browser, what the
 * server wrote into the page.
 */
export const getClientConfig = createIsomorphicFn()
  .server((): ClientConfig => {
    const config: ClientConfig = {};
    for (const key of CLIENT_CONFIG_KEYS) {
      const value = process.env[key]?.trim();
      if (value) config[key] = value;
    }
    return config;
  })
  .client((): ClientConfig => window.__OPENSEO_CONFIG__ ?? {});

/** Inline script that hands the server's client config to the browser. */
export function clientConfigScript(): string {
  // Escape "<" so a value can never close the script tag.
  const json = JSON.stringify(getClientConfig()).replace(/</g, "\\u003c");
  return `window.__OPENSEO_CONFIG__=${json};`;
}
