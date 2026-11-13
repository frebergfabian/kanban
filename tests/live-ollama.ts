import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
import { Assistant, newSession } from "../server/ai.js";
import { Store } from "../server/store.js";
import type { ChatEvent, ChatContext } from "../shared/schema.js";

try {
  loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const store = new Store(":memory:");
const assistant = new Assistant(store, {
  url: process.env.OLLAMA_URL ?? "http://localhost:11434",
  model: process.env.OLLAMA_MODEL ?? "qwen3:8b",
  timeout: Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000),
});
const session = newSession();
async function ask(message: string, context: ChatContext = {}) {
  console.log(`\nDu: ${message}`);
  const events: ChatEvent[] = [];
  await assistant.chat(
    message,
    session,
    (event) => {
      events.push(event);
      if (event.type === "done") console.log(event.message);
    },
    undefined,
    context,
  );
  const result = events.find((e) => e.type === "done");
  assert.ok(
    result && result.type === "done" && !result.error,
    "Ollama-anropet misslyckades.",
  );
  return result.message;
}
try {
  if (!process.argv.includes("--workspace-only")) {
    await ask("Skapa fem uppgifter för att installera en Linux-server");
    assert.equal(store.list().length, 5, "Modellen ska skapa exakt fem kort.");
    const task = store.list()[0];
    await ask(
      `Flytta uppgiften med ID ${task.id} till Pågår och sätt hög prioritet på samma uppgift.`,
    );
    assert.equal(store.get(task.id).status, "in_progress");
    assert.equal(store.get(task.id).priority, "high");
    await ask(`Be om borttagning av uppgiften med ID ${task.id}.`);
    assert.equal(store.list().length, 5, "AI får aldrig radera själv.");
    assert.ok(
      [...session.pending.values()].some((p) => p.task.id === task.id),
      "Modellen ska begära UI-bekräftelse.",
    );
  }
  await ask(
    "Skapa en ny tavla som heter Serverplan med målet En verifierad Debian-installation. Ge den AI-instruktionen Skriv verifierbara steg. Lägg tre konkreta uppgifter på den nya tavlan.",
  );
  const board = store.boards().find((b) => b.name === "Serverplan");
  assert.ok(board, "Modellen ska kunna skapa en tavla.");
  assert.equal(
    store.list(board.id).length,
    3,
    "Korten ska hamna på den nya tavlan.",
  );
  await ask("Lägg till en kolumn som heter Granskning precis före Klart.", {
    board_id: board.id,
  });
  const review = store.columns(board.id).find((c) => c.name === "Granskning");
  assert.ok(review, "Modellen ska skapa en egen kolumn.");
  assert.equal(review.position, 2);
  const selected = store.list(board.id)[0];
  await ask(
    "Skriv en uppdatering på det valda kortet: Nätverket fungerar nu. TLS återstår och måste verifieras innan vi är klara.",
    { board_id: board.id, task_id: selected.id },
  );
  const posts = store
    .detail(selected.id)
    .posts.filter((p) => p.kind !== "event");
  assert.equal(posts.length, 1, "Modellen ska skriva en flödespost.");
  assert.equal(posts[0].author, "assistant");
  assert.match(posts[0].content, /TLS/i);
  const before = store.revision();
  const analysis = await ask(
    "Läs det valda kortets flöde och föreslå nästa steg. Ändra ingenting.",
    { board_id: board.id, task_id: selected.id },
  );
  assert.equal(store.revision(), before, "En analys får inte ändra tavlan.");
  console.log(
    "\nOK: kort, flytt, prioritet, raderingsbegäran, nya tavlor, egna kolumner, flödesinlägg och läsning mot lokal Ollama.",
  );
} finally {
  store.close();
}
