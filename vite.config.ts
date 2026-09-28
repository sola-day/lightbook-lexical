import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "example",
  plugins: [react()],
  server: { port: 5184 },
  build: {
    outDir: "../example-dist",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      // See lightbook-prosemirror/vite.config.ts for why: loro-crdt's
      // default entry uses the WASM ESM-integration proposal syntax, which
      // neither Vite's esbuild dep pre-bundling nor a plain Rollup build
      // understands without extra plugins. `/base64` inlines the wasm.
      "loro-crdt": "loro-crdt/base64",
    },
  },
});
