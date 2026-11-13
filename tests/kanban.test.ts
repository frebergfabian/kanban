import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, request as httpRequest } from "node:http";
import { Store } from "../server/store.js";
import { Assistant, newSession } from "../server/ai.js";
import { createApp } from "../server/app.js";
import type { ChatEvent } from "../shared/schema.js";

const config = {
  url: "http://ollama.test",
  model: "test-tools",
  timeout: 1000,
};
const call = (name: string, args: unknown = {}) => ({
  function: { name, arguments: args },
});
const answer = (
  tool_calls?: ReturnType<typeof call>[],
  content = "Klart!",
) => ({
  message: {
    role: "assistant",
    content,
    ...(tool_calls ? { tool_calls } : {}),
  },
});
function fake(
  responses: unknown[],
  inspect?: (body: Record<string, any>, index: number) => void,
): typeof fetch {
  let index = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["completion", "tools"] });
    inspect?.(JSON.parse(String(init?.body)), index);
    const result = responses[index++];
    if (!result) throw new Error("Unexpected Ollama request");
    return Response.json(result);
  }) as typeof fetch;
}

test("SQLite: CRUD, valid dates, transactional moves, stable order and restart persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  const path = join(dir, "board.sqlite");
  let store = new Store(path);
  try {
    const a = store.create({ title: "  Installera Debian  " });
    const b = store.create({ title: "Backup" });
    const c = store.create({ title: "Säkerhet" });
    assert.equal(a.title, "Installera Debian");
    assert.throws(() => store.create({ title: "   " }));
    assert.throws(() => store.create({ title: "Fel", due_date: "2026-02-30" }));
    store.update(c.id, { position: 0 });
    assert.deepEqual(
      store.list().map((t) => [t.id, t.position]),
      [
        [c.id, 0],
        [a.id, 1],
        [b.id, 2],
      ],
    );
    const beforeRollback = store.list();
    store.db
      .exec(`CREATE TRIGGER fail_reorder BEFORE UPDATE OF position ON tasks
      WHEN NEW.title = 'Backup' AND NEW.position != OLD.position
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
    assert.throws(
      () => store.update(c.id, { status: "in_progress" }),
      /simulated write failure/,
    );
    assert.deepEqual(
      store.list(),
      beforeRollback,
      "A failure midway through reordering must roll back the entire move.",
    );
    store.db.exec("DROP TRIGGER fail_reorder");
    store.update(a.id, {
      status: "in_progress",
      priority: "high",
      due_date: "2026-12-01",
    });
    assert.deepEqual(
      store
        .list()
        .filter((t) => t.status === "todo")
        .map((t) => t.position),
      [0, 1],
    );
    assert.equal(store.get(a.id).position, 0);
    store.update(b.id, { status: "in_progress", position: 0 });
    assert.deepEqual(
      store
        .list()
        .filter((t) => t.status === "in_progress")
        .map((t) => t.id),
      [b.id, a.id],
    );
    const snapshot = store.list();
    assert.throws(() => store.update(a.id, { status: "invalid" } as never));
    assert.deepEqual(store.list(), snapshot);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.list(), snapshot);
    store.delete(b.id);
    assert.equal(store.get(a.id).position, 0);
    assert.throws(() => store.get(b.id));
    assert.deepEqual(
      store.list().map((t) => t.id),
      [c.id, a.id],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AI tool loop: five cards, fresh board, tool results and multiple successful actions", async () => {
  const store = new Store(":memory:");
  const events: ChatEvent[] = [];
  const session = newSession();
  let toolResults = false;
  const assistant = new Assistant(
    store,
    config,
    fake(
      [
        answer([call("get_board")]),
        answer(
          Array.from({ length: 5 }, (_, i) =>
            call("create_task", {
              title: `Steg ${i + 1}`,
              description: "Installera servern",
            }),
          ),
        ),
        answer(undefined, "Jag skapade hundra uppgifter!"),
      ],
      (body, index) => {
        if (index === 1) assert.equal(body.messages.at(-1).role, "tool");
        if (index === 2) {
          toolResults = true;
          assert.equal(
            body.messages.filter(
              (m: any) => m.role === "tool" && m.tool_name === "create_task",
            ).length,
            5,
          );
          assert.match(body.messages[0].content, /Steg 5/);
        }
      },
    ),
  );
  try {
    await assistant.chat("Skapa fem uppgifter", session, (e) => events.push(e));
    assert.equal(store.list().length, 5);
    assert.ok(toolResults);
    assert.equal(events.filter((e) => e.type === "board").length, 6);
    const done = events.find((e) => e.type === "done");
    assert.ok(done?.type === "done");
    assert.equal(done.message.split("\n").length, 5);
    assert.doesNotMatch(done.message, /hundra/);
    const id = store.list()[0].id;
    const mover = new Assistant(
      store,
      config,
      fake([
        answer([
          call("move_task", { id, status: "in_progress" }),
          call("update_task", {
            id,
            fields: { priority: "high", description: "Prioriterad" },
          }),
        ]),
        answer(),
      ]),
    );
    await mover.chat("Flytta och prioritera Steg 1", session, () => {});
    assert.equal(store.get(id).status, "in_progress");
    assert.equal(store.get(id).priority, "high");
  } finally {
    store.close();
  }
});

test("AI security: allowlist, strict arguments, no SQL/shell or model-controlled delete confirmation", async () => {
  const store = new Store(":memory:");
  const session = newSession();
  const assistant = new Assistant(store, config, fake([]));
  try {
    const task = store.create({ title: "Behåll mig" });
    for (const name of [
      "execute_sql",
      "delete_task",
      "shell",
      "constructor",
      "__proto__",
    ])
      assert.throws(() =>
        assistant.execute(
          name,
          { id: task.id, sql: "DROP TABLE tasks" },
          session,
        ),
      );
    assert.throws(() =>
      assistant.execute(
        "update_task",
        {
          id: task.id,
          fields: { id: "changed", position: 100, status: "done" },
        },
        session,
      ),
    );
    assert.throws(() =>
      assistant.execute(
        "request_delete_task",
        { id: task.id, confirmed: true },
        session,
      ),
    );
    assert.throws(() =>
      assistant.execute(
        "create_task",
        { title: "Injected", sql: "DROP TABLE tasks" },
        session,
      ),
    );
    const request = assistant.execute(
      "request_delete_task",
      { id: task.id },
      session,
    );
    assert.ok(request.deletion);
    assert.equal(store.get(task.id).title, "Behåll mig");
    assert.equal(session.pending.size, 1);
    const events: ChatEvent[] = [];
    const liar = new Assistant(
      store,
      config,
      fake([
        answer([call("delete_task", { id: task.id })]),
        answer(undefined, "Tog bort uppgiften!"),
      ]),
    );
    await liar.chat("Ta bort uppgiften", session, (e) => events.push(e));
    const done = events.find((e) => e.type === "done");
    assert.ok(done?.type === "done");
    assert.match(done.message, /inte tillåtet/);
    assert.doesNotMatch(done.message, /Tog bort/);
    assert.equal(store.list().length, 1);
  } finally {
    store.close();
  }
});

test("AI limits, offline status, unsupported model and partially saved actions", async () => {
  const store = new Store(":memory:");
  try {
    const offline = new Assistant(store, config, (async () => {
      throw new TypeError("ECONNREFUSED");
    }) as typeof fetch);
    assert.equal((await offline.status()).available, false);
    const noTools = new Assistant(store, config, (async () =>
      Response.json({ capabilities: ["completion"] })) as typeof fetch);
    assert.match((await noTools.status()).message, /tool calling/);
    const events: ChatEvent[] = [];
    const limited = new Assistant(
      store,
      config,
      fake([
        answer(
          Array.from({ length: 55 }, (_, i) =>
            call("create_task", { title: `Task ${i}` }),
          ),
        ),
      ]),
    );
    await limited.chat("Test", newSession(), (e) => events.push(e));
    assert.equal(store.list().length, 48);
    const done = events.find((e) => e.type === "done");
    assert.ok(done?.type === "done");
    assert.match(done.message, /48 verktygsanrop/);
    assert.equal(done.message.match(/Skapade/g)?.length, 48);
    const loop = new Assistant(
      store,
      config,
      fake(Array.from({ length: 13 }, () => answer([call("get_board")]))),
    );
    const loopEvents: ChatEvent[] = [];
    await loop.chat("Loop", newSession(), (e) => loopEvents.push(e));
    assert.ok(
      loopEvents.some(
        (e) => e.type === "done" && e.message.includes("steggräns"),
      ),
    );
    const task = store.create({ title: "Fungerar utan AI" });
    assert.ok(store.get(task.id));
  } finally {
    store.close();
  }
});

test("AI cannot claim changes without write tools; read summaries use current DB", async () => {
  const store = new Store(":memory:");
  try {
    store.create({ title: "Verkligt kort" });
    const events: ChatEvent[] = [];
    const liar = new Assistant(
      store,
      config,
      fake([
        answer(undefined, "Jag skapade fem kort och flyttade allt till Klart."),
      ]),
    );
    await liar.chat("Skapa fem kort", newSession(), (e) => events.push(e));
    assert.ok(
      events.some(
        (e) =>
          e.type === "done" && e.message.startsWith("Inga ändringar gjordes."),
      ),
    );
    assert.ok(
      !events.some(
        (e) => e.type === "done" && e.message.includes("Jag skapade"),
      ),
    );
    const summaries: ChatEvent[] = [];
    const reader = new Assistant(
      store,
      config,
      fake([
        answer([call("get_board")]),
        answer(undefined, "Det finns inga uppgifter."),
      ]),
    );
    await reader.chat("Vad återstår?", newSession(), (e) => summaries.push(e));
    assert.ok(
      summaries.some(
        (e) => e.type === "done" && e.message.includes("Verkligt kort"),
      ),
    );
    const questions: ChatEvent[] = [];
    const questioner = new Assistant(
      store,
      config,
      fake([answer(undefined, "Vilken backup-uppgift menar du?")]),
    );
    await questioner.chat("Flytta backup", newSession(), (e) =>
      questions.push(e),
    );
    assert.ok(
      questions.some(
        (e) =>
          e.type === "done" && e.message === "Vilken backup-uppgift menar du?",
      ),
    );
  } finally {
    store.close();
  }
});

test("HTTP: REST validation and explicit session-bound delete confirmation, including stale request", async (t) => {
  const store = new Store(":memory:");
  const initial = store.create({ title: "Testkort" });
  const assistant = new Assistant(
    store,
    config,
    fake([
      answer([call("request_delete_task", { id: initial.id })]),
      answer(),
      answer([call("request_delete_task", { id: initial.id })]),
      answer(),
    ]),
  );
  const server = createApp(store, assistant).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
  ) {
    return fetch(base + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  assert.equal(
    (await request("/api/tasks", "POST", { title: "  " })).status,
    400,
  );
  const created = await (
    await request("/api/tasks", "POST", { title: "REST" })
  ).json();
  assert.equal(created.task.title, "REST");
  assert.equal(
    (await request(`/api/tasks/${initial.id}`, "PATCH", { sql: "DELETE" }))
      .status,
    400,
  );
  assert.equal(
    (await request(`/api/tasks/${initial.id}`, "DELETE", {})).status,
    400,
  );
  const crossSite = await fetch(base + "/api/tasks", {
    method: "POST",
    headers: {
      Origin: "https://unrelated.example",
      "Content-Type": "application/json",
    },
    body: '{"title":"No"}',
  });
  assert.equal(crossSite.status, 403);
  const rebindStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const req = httpRequest(
        base + "/api/tasks",
        { headers: { Host: "rebind.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  assert.equal(rebindStatus, 403);
  let stream = await request("/api/ai/chat", "POST", {
    message: "Ta bort Testkort",
  });
  const cookie = stream.headers.get("set-cookie")!.split(";")[0];
  let events = (await stream.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ChatEvent);
  let deletion = events.find((e) => e.type === "deletion");
  assert.ok(deletion?.type === "deletion");
  assert.equal(store.list().length, 2);
  assert.equal(
    (
      await request(`/api/tasks/${initial.id}`, "DELETE", {
        confirmed: true,
        request_id: deletion.deletion.request_id,
      })
    ).status,
    409,
  );
  store.update(initial.id, { title: "Ändrad" });
  assert.equal(
    (
      await request(
        `/api/tasks/${initial.id}`,
        "DELETE",
        { confirmed: true, request_id: deletion.deletion.request_id },
        cookie,
      )
    ).status,
    409,
  );
  stream = await request(
    "/api/ai/chat",
    "POST",
    { message: "Ta bort det ändrade kortet" },
    cookie,
  );
  events = (await stream.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  deletion = events.find((e) => e.type === "deletion");
  assert.ok(deletion?.type === "deletion");
  const removed = await request(
    `/api/tasks/${initial.id}`,
    "DELETE",
    { confirmed: true, request_id: deletion.deletion.request_id },
    cookie,
  );
  assert.equal(removed.status, 200);
  assert.equal(store.list().length, 1);
  assert.equal(
    (
      await request(`/api/tasks/${created.task.id}`, "DELETE", {
        confirmed: true,
      })
    ).status,
    200,
  );
  assert.equal((await (await request("/api/tasks")).json()).tasks.length, 0);
});

test("Ollama HTTP integration uses configured model, real endpoint and tool round trips without cloud", async (t) => {
  const store = new Store(":memory:");
  let count = 0;
  const ollama = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.model, "local-test");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/show") {
      res.end(JSON.stringify({ capabilities: ["tools"] }));
      return;
    }
    assert.equal(req.url, "/api/chat");
    if (count++ === 0)
      res.end(
        JSON.stringify(
          answer([call("create_task", { title: "Från simulerad Ollama" })]),
        ),
      );
    else {
      assert.equal(data.messages.at(-1).tool_name, "create_task");
      res.end(JSON.stringify(answer()));
    }
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => ollama.once("listening", resolve));
  t.after(async () => {
    ollama.closeAllConnections();
    await new Promise<void>((resolve) => ollama.close(() => resolve()));
    store.close();
  });
  const assistant = new Assistant(store, {
    url: `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`,
    model: "local-test",
    timeout: 1000,
  });
  await assistant.chat("Skapa ett kort", newSession(), () => {});
  assert.equal(store.list()[0].title, "Från simulerad Ollama");
  assert.equal(count, 2);
});
