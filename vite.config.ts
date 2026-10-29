import react from "@vitejs/plugin-react";
import { themeInitScript } from "agentic-design/react";
import { defineConfig } from "vite";

// The page head gets the theme script inline, so a saved dark pick never flashes light.
export default defineConfig({
  root: "ui",
  base: "./",
  plugins: [
    react(),
    { name: "theme-init", transformIndexHtml: (html) => html.replace("<!--theme-init-->", `<script>${themeInitScript()}</script>`) },
  ],
  build: { outDir: "../ui-dist", emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/api": "http://127.0.0.1:8787", "/health": "http://127.0.0.1:8787" } },
});
