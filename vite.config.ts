import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths: in production the page is loaded from file://.
  base: "./",
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
  server: { strictPort: false },
});
