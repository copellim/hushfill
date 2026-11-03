import { defineConfig } from "vite";

export default defineConfig({
  // Percorsi relativi: in produzione la pagina è caricata da file://.
  base: "./",
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
  server: { strictPort: false },
});
