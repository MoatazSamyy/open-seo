// Stand-in for the `cloudflare:workflows` module in the Node build (aliased in
// vite.node.config.ts), for workflow code that's imported but can't run on
// Node until fork milestone 3d.
export class NonRetryableError extends Error {}
