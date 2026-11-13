import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { Assistant } from "../server/ai.js";
import { JobQueue } from "../server/jobs.js";
try {
  loadEnvFile(".env");
} catch {}
const store = new Store(":memory:"),
  assistant = new Assistant(store, {
    url: process.env.OLLAMA_URL ?? "http://localhost:11434",
    model: process.env.OLLAMA_MODEL ?? "qwen3:8b",
    timeout: 120000,
  }),
  queue = new JobQueue(assistant);
async function ask(message: string, board_id = store.defaultBoardId()) {
  console.log("\nDu:", message);
  const job = queue.submit({ message, board_id, request_id: randomUUID() });
  let last = "";
  for (let i = 0; i < 3600; i++) {
    const current = assistant.knowledge.job(job.id);
    if (current.progress !== last) {
      last = current.progress;
      console.log(current.status, last);
    }
    if (!["queued", "running"].includes(current.status)) {
      console.log(current.result);
      assert.ok(
        !["failed", "cancelled", "interrupted"].includes(current.status),
        current.error ?? "Job failed",
      );
      return current;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Job timeout");
}
try {
  await ask(
    "Kom ihåg denna varaktiga preferens för alla tavlor: Jag vill ha korta svenska svar, och nya kort ska ha ett tydligt avsnitt med rubriken Klart när i beskrivningen. Spara detta som minne.",
  );
  assert.ok(
    assistant.knowledge
      .memories()
      .some((m) => m.source_message_id && m.kind === "preference"),
    "Memory must have a real user source",
  );
  await ask(
    "Skapa ett kort som heter Kontrollera backupen. Använd min sparade preferens för hur kort beskrivs.",
  );
  const task = store.list().find((t) => t.title === "Kontrollera backupen");
  assert.ok(task);
  assert.match(task.description, /klart när/i);
  const before = store.revision();
  const history = await ask(
    "Vad bad jag dig komma ihåg tidigare? Sök i våra tidigare konversationer och svara kort. Ändra ingenting.",
  );
  assert.match(history.result, /svensk|klart när/i);
  assert.equal(store.revision(), before);
  const board = store.createBoard({ name: "Tillfällig testtavla" });
  const deletion = await ask("Ta bort den här tavlan.", board.id);
  assert.equal(deletion.status, "needs_input");
  assert.ok(
    assistant.knowledge
      .pending()
      .some((p) => p.kind === "board" && p.target_id === board.id),
  );
  assert.ok(store.board(board.id));
  console.log(
    "\nOK: real local model saved sourced memory, recalled it in a new conversation, created a card with the preference, searched durable history, and proposed board deletion with correct UUID and human confirmation.",
  );
} finally {
  await queue.close();
  store.close();
}
