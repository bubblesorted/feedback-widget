import { defineConfig } from "tsup";

export default defineConfig([
  {
    // The browser half. Every module here is client code; "use client" lets a React Server Component layout render
    // <FeedbackWidget> directly. Splitting keeps the panel (and html-to-image) in a chunk loaded on first open.
    entry: { "client/index": "src/client/index.ts" },
    format: ["esm"],
    dts: true,
    splitting: true,
    sourcemap: true,
    clean: false,
    target: "es2022",
    external: ["react", "react-dom", "react/jsx-runtime"],
    banner: { js: '"use client";' },
  },
  {
    entry: { "server/index": "src/server/index.ts", contract: "src/contract.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "es2022",
    platform: "node",
  },
]);
