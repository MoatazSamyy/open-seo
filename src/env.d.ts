// Custom environment variable type definitions
// These extend the auto-generated Env interface from worker-configuration.d.ts

declare namespace Cloudflare {
  interface Env {
    R2: R2Bucket;
    // Browser Run binding for site-audit JavaScript rendering, audit worker
    // only. Inline import preserves the ambient Env augmentation.
    // oxlint-disable-next-line typescript-eslint/consistent-type-imports
    BROWSER?: import("@cloudflare/workers-types").BrowserRun;
    // Context.dev key: the rendering fallback when Browser Run fails or is
    // blocked, and the only renderer on Docker.
    CONTEXT_API_KEY?: string;
    OAUTH_KV: KVNamespace;

    // Durable Object backing the SAM in-app agent (see wrangler.jsonc).
    SAM_CHAT: DurableObjectNamespace;

    // Durable Object holding per-audit crawl scratch state (frontier, link
    // edges, page mirror). Bound ONLY in the open-seo-audit aux worker;
    // untyped here — getAuditScratchpad narrows the stub.
    AUDIT_SCRATCHPAD: DurableObjectNamespace;

    // Service binding to the audit worker's AuditEngine entrypoint (cancel +
    // GDPR erasure of scratchpad state). The inline import() is required: a
    // top-level import would turn this ambient file into a module and break
    // the global augmentation.
    // oxlint-disable-next-line typescript-eslint/consistent-type-imports
    AUDIT_ENGINE: Service<typeof import("./audit-worker").default>;

    AUTH_MODE?: "cloudflare_access" | "local_noauth" | "hosted" | "password";
    BYPASS_EMAIL_VERIFICATION?: string;
    TEAM_DOMAIN?: string;
    POLICY_AUD?: string;
    POSTHOG_PUBLIC_KEY?: string;
    POSTHOG_HOST?: string;
    BETTER_AUTH_SECRET?: string;
    BETTER_AUTH_URL?: string;
    // AUTH_MODE=password only: comma-separated emails and "@domain" entries
    // allowed to create an account (src/server/auth/password-signup.ts).
    ALLOWED_SIGNUP_EMAILS?: string;
    // Encrypts saved Shopify crawler signatures. Kept separate from
    // BETTER_AUTH_SECRET so the audit worker never holds the auth secret.
    CRAWLER_ACCESS_SECRET?: string;
    DATABASE_PROVIDER?: "d1" | "postgres";
    HYPERDRIVE?: {
      connectionString: string;
    };
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    LOOPS_API_KEY?: string;
    LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID?: string;
    LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID?: string;
    LOOPS_TRANSACTIONAL_INVITATION_ID?: string;
    AUTUMN_SECRET_KEY?: string;
    AUTUMN_WEBHOOK_SECRET?: string;
    // Dub referral conversion tracking (hosted only); all Dub code no-ops
    // when unset.
    DUB_API_KEY?: string;
    // HMAC secret for the operator-only GDPR storage-erasure endpoint.
    GDPR_ERASURE_SECRET?: string;

    // Cloudflare Turnstile — signup captcha (hosted only). Secret verifies
    // tokens server-side; site key is public and inlined into the client build.
    TURNSTILE_SECRET_KEY?: string;
    TURNSTILE_SITE_KEY?: string;

    // DataForSEO API Basic auth value (base64 of login:password)
    DATAFORSEO_API_KEY: string;
    // Live organic SERP provider: "dataforseo" (default) or "serper". See
    // docs/maintainers/specs/0016-serp-provider-routing.md.
    SERP_PROVIDER?: string;
    // Serper.dev API key; required when SERP_PROVIDER=serper.
    SERPER_API_KEY?: string;
    // Country-level keyword metrics provider: "dataforseo" (default) or
    // "keywords_everywhere". See fetchKeywordMetricsForList.
    KEYWORD_METRICS_PROVIDER?: string;
    // Keywords Everywhere API key; required when
    // KEYWORD_METRICS_PROVIDER=keywords_everywhere.
    KEYWORDS_EVERYWHERE_API_KEY?: string;
    // "google_autocomplete" serves keyword research ideas from Google
    // autocomplete (free, no metrics) instead of DataForSEO.
    KEYWORD_IDEAS_PROVIDER?: string;
    // "openrouter" asks AI visibility prompts through OpenRouter instead of
    // DataForSEO (self-hosted only). Needs OPENROUTER_API_KEY.
    AI_VISIBILITY_PROVIDER?: string;
    AI_VISIBILITY_WORKFLOW: Workflow<
      (
        | { runId: string }
        | { setupProjectId: string; runSeededTracking?: boolean }
      ) & {
        customer: {
          organizationId: string;
          userId: string;
          userEmail: string;
          projectId?: string;
        };
      }
    >;

    // OpenRouter API key for the SAM in-app chat agent.
    OPENROUTER_API_KEY?: string;
    // Optional OpenRouter model slug override (defaults in openrouter.ts).
    OPENROUTER_MODEL?: string;
  }
}

// AUTH_MODE, BYPASS_EMAIL_VERIFICATION, POSTHOG_* and TURNSTILE_SITE_KEY are
// not build-time env: the client reads them via src/lib/client-config.ts.
interface ImportMetaEnv {
  readonly DATABASE_PROVIDER?: "d1" | "postgres";
  readonly VITE_E2E_DOMAIN_FIXTURES?: string;
  readonly VITE_E2E_KEYWORD_FIXTURES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.md?raw" {
  const content: string;
  export default content;
}
