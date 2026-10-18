import { waitUntil } from "@/platform/runtime";
import { createWorkflowBinding } from "./workflows";

// Stand-in for the `cloudflare:workers` module in the Node build (aliased in
// vite.node.config.ts). Code that moved to "@/platform/runtime" never gets
// here; this covers the files .oxlintrc.json still lets import the Workers
// runtime for Workflow, Durable Object, service, and Browser bindings.
//
// String settings read from process.env. Workflow bindings run on the
// Postgres-backed runner (./workflows.ts). A binding Node doesn't have yet
// resolves to an object that throws a clear error when used, so the app boots
// and only the feature that needs it fails.

const WORKFLOW_BINDINGS = new Set([
  "SITE_AUDIT_WORKFLOW",
  "RANK_CHECK_WORKFLOW",
  "AI_VISIBILITY_WORKFLOW",
]);
const workflowBindings = new Map<
  string,
  ReturnType<typeof createWorkflowBinding>
>();

function workflowBinding(name: string) {
  let binding = workflowBindings.get(name);
  if (!binding) {
    binding = createWorkflowBinding(name);
    workflowBindings.set(name, binding);
  }
  return binding;
}

const PENDING_BINDINGS: Record<string, string> = {
  AUDIT_ENGINE: "3e (in-process site audit)",
  AUDIT_SCRATCHPAD: "3e (in-process site audit)",
  BROWSER: "3e (in-process site audit)",
  SAM_CHAT: "3f (SAM chat without Durable Objects)",
  OAUTH_KV: "hosted mode, which doesn't run on Node",
};

function unavailableBinding(name: string, milestone: string): object {
  const fail = () => {
    throw new Error(
      `${name} isn't available on the Node runtime yet (fork milestone ${milestone}).`,
    );
  };
  return new Proxy(
    {},
    {
      // "then" stays undefined so `await binding` doesn't throw by itself.
      get: (_target, prop) => (prop === "then" ? undefined : fail),
    },
  );
}

export const env: Record<string, unknown> = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      const value = process.env[prop];
      if (value !== undefined) return value;
      if (WORKFLOW_BINDINGS.has(prop)) return workflowBinding(prop);
      const milestone = PENDING_BINDINGS[prop];
      return milestone ? unavailableBinding(prop, milestone) : undefined;
    },
  },
);

export { waitUntil };

// Base classes some bound modules extend; never instantiated on Node.
/* oxlint-disable typescript/no-extraneous-class -- empty stand-ins for the Workers base classes */
export class DurableObject {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
/* oxlint-enable typescript/no-extraneous-class */
