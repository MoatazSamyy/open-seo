import path from "node:path";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

// Build for the Node runtime (fork milestone 3c): the same app, without the
// Cloudflare plugin, with src/server.node.ts as the server entry and the
// runtime seam swapped for its Node implementation. Output goes to dist-node/
// and is served by scripts/node-server.mjs.

const src = (file: string) => path.resolve(import.meta.dirname, "src", file);

export default defineConfig({
  publicDir: "src/public",
  envPrefix: ["VITE_"],
  resolve: {
    alias: [
      {
        find: /^@\/platform\/runtime$/,
        replacement: src("platform/runtime.node.ts"),
      },
      {
        find: /^cloudflare:workers$/,
        replacement: src("platform/node/cloudflare-workers.ts"),
      },
      {
        find: /^cloudflare:workflows$/,
        replacement: src("platform/node/cloudflare-workflows.ts"),
      },
    ],
  },
  build: {
    outDir: "dist-node",
  },
  plugins: [
    tsConfigPaths(),
    tanstackStart({ server: { entry: "server.node.ts" } }),
    viteReact(),
    tailwindcss(),
  ],
});
