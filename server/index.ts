import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Store } from "./store.js";
import { Assistant } from "./ai.js";
import { createApp } from "./app.js";

// Works from both source and compiled output; commands run from the project root.
const root = process.cwd();
try {
  loadEnvFile(resolve(root, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT måste vara ett tal mellan 1 och 65535.");
const timeout = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000);
if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300000)
  throw new Error("OLLAMA_TIMEOUT_MS måste vara 1000–300000.");
const url = new URL(process.env.OLLAMA_URL ?? "http://localhost:11434");
if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
  throw new Error(
    "OLLAMA_URL ska vara en HTTP-adress utan inloggningsuppgifter.",
  );
const store = new Store(
  resolve(root, process.env.DATABASE_PATH ?? "data/kanban.sqlite"),
);
const assistant = new Assistant(store, {
  url: url.toString(),
  model: process.env.OLLAMA_MODEL ?? "qwen3:8b",
  timeout,
});
const app = createApp(store, assistant);
let vite: import("vite").ViteDevServer | undefined;
const compiled = fileURLToPath(import.meta.url).includes("/dist/server/");
if (!compiled) {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const { default: express } = await import("express");
  app.use(express.static(resolve(root, "dist/client")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve(root, "dist/client/index.html")),
  );
}
const host = process.env.HOST ?? "127.0.0.1";
const server = app.listen(port, host, () =>
  console.log(`Kanban: http://${host}:${port} · ${assistant.config.model}`),
);
server.on("error", (error) => {
  console.error("Kunde inte starta Kanban:", error.message);
  process.exit(1);
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  await vite?.close();
  await app.locals.jobQueue.close();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
