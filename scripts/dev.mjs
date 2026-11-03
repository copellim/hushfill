// Sviluppo: server Vite con hot reload + Electron puntato al server.
// Argomenti extra vengono passati a Electron (es. npm run dev -- ~/doc.pdf).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];

const child = spawn(electronPath, [".", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
