import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
import { Store } from "../server/store.js";
import { Assistant, newSession } from "../server/ai.js";
import type { ChatEvent, ChatContext } from "../shared/schema.js";
try {
  loadEnvFile(".env");
} catch {}
const store = new Store(":memory:"),
  assistant = new Assistant(
    store,
    {
      url: process.env.OLLAMA_URL ?? "http://localhost:11434",
      model: process.env.OLLAMA_MODEL ?? "qwen3:8b",
      timeout: 120000,
    },
    async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/api/chat")) {
        const data = await response.clone().json();
        console.log(
          "Model:",
          JSON.stringify(data.message),
          "prompt tokens:",
          data.prompt_eval_count,
        );
      }
      return response;
    },
  ),
  session = newSession();
async function ask(message: string, context: ChatContext) {
  console.log("\nDu:", message);
  const events: ChatEvent[] = [];
  await assistant.chat(
    message,
    session,
    (event) => {
      events.push(event);
      if (event.type === "progress" || event.type === "done")
        console.log(event.message);
    },
    undefined,
    context,
  );
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done" && !done.error, "AI request failed");
}
try {
  const master = store.create({
    title: "Säker hemportal",
    description:
      "Vi ska få fungerande TLS, inloggning och övervakning. Klart när dessa är verifierade.",
  });
  await ask(
    "Skapa en Scrum-tavla under det valda masterkortet med exakt tre välbeskrivna backlogkort.",
    { board_id: master.board_id, task_id: master.id },
  );
  const child = store.childBoard(master.id);
  assert.ok(child);
  assert.equal(store.board(child.id).kind, "scrum");
  assert.equal(store.list(child.id).length, 3);
  assert.ok(
    store
      .list(child.id)
      .every((t) => t.sprint_id === null && t.status === "backlog"),
  );
  await ask(
    "Planera en sprint som heter Sprint 1 med målet Verifierad åtkomst. Lägg alla tre befintliga backlogkort i den sprinten och starta sprinten. Skapa inga nya kort.",
    { board_id: child.id },
  );
  assert.equal(
    store.sprints(child.id).length,
    1,
    "Exactly one sprint should be created",
  );
  const sprint = store.sprints(child.id)[0];
  assert.ok(sprint);
  assert.equal(sprint.status, "active");
  assert.equal(sprint.task_count, 3);
  assert.equal(store.list(child.id).length, 3);
  const task = store.list(child.id)[0];
  store.update(task.id, { status: "done" });
  await ask(
    "Avsluta den aktiva sprinten. Låt de ofärdiga korten ligga kvar och behåll masterkortets status.",
    { board_id: child.id, sprint_id: sprint.id },
  );
  assert.equal(store.sprint(sprint.id).status, "completed");
  assert.equal(store.sprint(sprint.id).task_count, 3);
  assert.equal(store.sprint(sprint.id).done_count, 1);
  assert.equal(store.get(master.id).status, "todo");
  assert.equal(store.childBoard(master.id)?.done_count, 1);
  console.log(
    "\nOK: live Ollama created linked Scrum, planned and assigned three cards, started and completed sprint, preserved unfinished cards and master status.",
  );
} finally {
  store.close();
}
