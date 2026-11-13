import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Assistant, newSession } from "../server/ai.js";
import { createApp } from "../server/app.js";
import type { AddressInfo } from "node:net";

function setup(store: Store) {
  const master = store.create({
    title: "Leverera hemportalen",
    description: "Verifierad åtkomst och övervakning",
  });
  const scrum = store.createBoard({
    name: "Portal Scrum",
    kind: "scrum",
    parent_task_id: master.id,
  });
  return { master, scrum };
}
test("linked Scrum persists, reports progress, follows a moved master and protects its hierarchy", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrum-")),
    path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const { master, scrum } = setup(store);
    assert.deepEqual(
      store.columns(scrum.id).map((c) => c.key),
      ["backlog", "todo", "in_progress", "review", "done"],
    );
    const child = store.create({ title: "Verifiera TLS", board_id: scrum.id });
    assert.equal(child.status, "backlog");
    assert.equal(store.get(master.id).child_board?.task_count, 1);
    store.update(child.id, {
      column_id: store.columns(scrum.id).find((c) => c.is_done)!.id,
    });
    assert.equal(store.get(master.id).child_board?.done_count, 1);
    assert.equal(store.get(master.id).status, "todo");
    assert.throws(() => store.delete(master.id), /Frikoppla/);
    assert.throws(
      () =>
        store.createBoard({
          name: "Dublett",
          kind: "scrum",
          parent_task_id: master.id,
        }),
      /redan/,
    );
    assert.throws(
      () => store.createBoard({ name: "Fel", parent_task_id: master.id }),
      /Endast/,
    );
    assert.throws(
      () => store.update(master.id, { board_id: scrum.id }),
      /masterkort/i,
    );
    const other = store.createBoard({ name: "Annat projekt" });
    store.update(master.id, { board_id: other.id });
    assert.equal(store.board(scrum.id).parent_board_id, other.id);
    const snapshot = store.workspace(scrum.id);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.workspace(scrum.id), snapshot);
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
    store.updateBoard(scrum.id, { parent_task_id: null });
    store.delete(master.id);
    assert.equal(store.get(child.id).board_id, scrum.id);
    assert.equal(store.board(scrum.id).parent_task_id, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("sprints validate dates, enforce one active sprint, atomically assign and preserve unfinished work", () => {
  const store = new Store(":memory:");
  try {
    const { master, scrum } = setup(store);
    assert.throws(
      () => store.createSprint(master.board_id, { name: "Fel" }),
      /Scrum/,
    );
    assert.throws(() =>
      store.createSprint(scrum.id, {
        name: "Fel datum",
        start_date: "2026-12-02",
        end_date: "2026-12-01",
      }),
    );
    const one = store.createSprint(scrum.id, {
        name: "Sprint 1",
        goal: "Fungerande TLS",
      }),
      two = store.createSprint(scrum.id, { name: "Sprint 2" });
    assert.throws(() => store.transitionSprint(one.id, "completed"), /aktiv/);
    store.transitionSprint(one.id, "active");
    assert.throws(() => store.transitionSprint(two.id, "active"), /redan/);
    const task = store.create({ title: "TLS", board_id: scrum.id }),
      foreign = store.create({ title: "Annat" });
    const revision = store.revision();
    assert.throws(() => store.assignSprint([task.id, foreign.id], one.id));
    assert.equal(store.revision(), revision);
    assert.equal(store.get(task.id).sprint_id, null);
    store.assignSprint([task.id], one.id);
    assert.equal(store.get(task.id).status, "todo");
    const done = store.create({
      title: "DNS",
      board_id: scrum.id,
      sprint_id: one.id,
    });
    store.update(done.id, { status: "done" });
    assert.equal(store.sprint(one.id).done_count, 1);
    store.transitionSprint(one.id, "completed");
    assert.equal(store.get(task.id).sprint_id, one.id);
    assert.equal(store.sprint(one.id).task_count, 2);
    assert.equal(store.get(master.id).status, "todo");
    assert.throws(
      () =>
        store.create({ title: "Sent", board_id: scrum.id, sprint_id: one.id }),
      /avslutad/,
    );
    store.assignSprint([task.id], null);
    assert.equal(store.get(task.id).status, "backlog");
    store.assignSprint([task.id], two.id);
    store.update(task.id, { column_id: store.columns(scrum.id)[0].id });
    assert.equal(store.get(task.id).sprint_id, null);
    store.assignSprint([task.id], two.id);
    store.update(task.id, { board_id: master.board_id });
    assert.equal(store.get(task.id).sprint_id, null);
    const another = store.createBoard({ name: "Annan Scrum", kind: "scrum" });
    assert.throws(
      () =>
        store.create({ title: "Fel", board_id: another.id, sprint_id: two.id }),
      /annan/,
    );
    assert.match(
      store
        .detail(master.id)
        .posts.map((p) => p.content)
        .join(" "),
      /Avslutade/,
    );
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
  } finally {
    store.close();
  }
});
test("AI tools inherit the selected master and sprint, return actual receipts and reject protected deletion", async () => {
  const store = new Store(":memory:");
  try {
    const master = store.create({ title: "Mitt projekt" }),
      assistant = new Assistant(store, {
        url: "http://offline",
        model: "tools",
        timeout: 1000,
      }),
      session = newSession();
    session.boardId = master.board_id;
    session.taskId = master.id;
    const result = assistant.execute(
      "create_scrum_board",
      {
        name: "Projekt Scrum",
        tasks: [{ title: "Del 1" }, { title: "Del 2" }],
      },
      session,
    );
    assert.equal(
      store.boards().find((b) => b.kind === "scrum")?.parent_task_id,
      master.id,
    );
    assert.ok(result.changed);
    const board = session.boardId!;
    const planned = assistant.execute(
      "create_sprint",
      { name: "Sprint A", goal: "Leverera A" },
      session,
    );
    assert.ok(planned.changed);
    const sprint = store.sprints(board)[0];
    session.sprintId = sprint.id;
    assistant.execute(
      "create_tasks",
      { tasks: [{ title: "Sprintkort 1" }, { title: "Sprintkort 2" }] },
      session,
    );
    assert.equal(store.sprint(sprint.id).task_count, 2);
    const ids = store
      .list(board)
      .filter((t) => !t.sprint_id)
      .map((t) => t.id);
    assistant.execute(
      "assign_to_sprint",
      { task_ids: ids, sprint_id: sprint.id },
      session,
    );
    assert.equal(store.sprint(sprint.id).task_count, 4);
    assert.match(
      assistant.execute("start_sprint", { id: sprint.id }, session).action!,
      /Startade/,
    );
    assert.match(
      assistant.execute("complete_sprint", { id: sprint.id }, session).action!,
      /Avslutade/,
    );
    assert.throws(
      () =>
        assistant.execute("request_delete_task", { id: master.id }, session),
      /Frikoppla/,
    );
    assert.equal(session.pending.size, 0);
  } finally {
    store.close();
  }
});
test("HTTP sprint API validates board scope, transition bodies and master deletion", async (t) => {
  const store = new Store(":memory:"),
    { master, scrum } = setup(store),
    assistant = new Assistant(store, {
      url: "http://offline",
      model: "tools",
      timeout: 1000,
    });
  const server = createApp(store, assistant).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body: unknown = {}, method = "POST") =>
    fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const response = await request(`/api/boards/${scrum.id}/sprints`, {
    name: "Sprint API",
  });
  assert.equal(response.status, 201);
  const { sprint } = await response.json();
  assert.equal(
    (await request(`/api/sprints/${sprint.id}/start`, { unexpected: true }))
      .status,
    400,
  );
  assert.equal((await request(`/api/sprints/${sprint.id}/start`)).status, 200);
  assert.equal(
    (await request(`/api/sprints/${sprint.id}/complete`)).status,
    200,
  );
  assert.equal(
    (await request(`/api/tasks/${master.id}`, { confirmed: true }, "DELETE"))
      .status,
    409,
  );
  assert.equal(
    (
      await request("/api/ai/chat", {
        message: "Hej",
        board_id: master.board_id,
        sprint_id: sprint.id,
      })
    ).status,
    400,
  );
});

test("existing multi-board database gains Scrum fields without changing cards or feeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrum-v2-")),
    path = join(dir, "old.sqlite"),
    db = new Database(path),
    board = randomUUID(),
    column = randomUUID(),
    task = randomUUID(),
    post = randomUUID();
  db.exec(`CREATE TABLE boards(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,instructions TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE columns(id TEXT PRIMARY KEY,board_id TEXT NOT NULL REFERENCES boards(id),key TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',is_done INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL,UNIQUE(board_id,key));
 CREATE TABLE tasks(id TEXT PRIMARY KEY,column_id TEXT NOT NULL REFERENCES columns(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',priority TEXT NOT NULL,due_date TEXT,position INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE posts(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,kind TEXT NOT NULL,author TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE metadata(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);INSERT INTO metadata VALUES(1,42);`);
  db.prepare("INSERT INTO boards VALUES (?,?,?,?,?,?)").run(
    board,
    "Befintligt projekt",
    "Syfte",
    "Bevara innehåll",
    "2026-01-01",
    "2026-01-02",
  );
  db.prepare("INSERT INTO columns VALUES (?,?,?,?,?,?,?)").run(
    column,
    board,
    "custom",
    "Verifierat",
    "Custom column",
    1,
    0,
  );
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)").run(
    task,
    column,
    "Befintligt kort",
    "Viktig beskrivning",
    "high",
    "2026-12-01",
    0,
    "2026-01-01",
    "2026-02-02",
  );
  db.prepare(
    "INSERT INTO posts(id,task_id,kind,author,content,created_at) VALUES(?,?,?,?,?,?)",
  ).run(post, task, "update", "user", "Verifierat underlag", "2026-02-02");
  db.close();
  let store = new Store(path);
  try {
    assert.equal(store.revision(), 42);
    assert.equal(store.get(task).updated_at, "2026-02-02");
    assert.equal(store.get(task).due_date, "2026-12-01");
    assert.equal(store.get(task).description, "Viktig beskrivning");
    assert.equal(store.get(task).sprint_id, null);
    assert.equal(store.get(task).child_board, null);
    assert.equal(store.board(board).kind, "kanban");
    assert.equal(store.board(board).parent_task_id, null);
    assert.equal(store.board(board).done_count, 1);
    assert.equal(store.detail(task).posts[0].id, post);
    const snapshot = store.workspace(board);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.workspace(board), snapshot);
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AI reuses a successful sprint creation and retries an explicit action once instead of claiming success", async () => {
  const store = new Store(":memory:");
  try {
    const { scrum } = setup(store);
    let round = 0;
    const request = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(url).endsWith("/api/show"))
        return Response.json({ capabilities: ["tools"] });
      const body = JSON.parse(String(init?.body));
      if (round++ < 2)
        return Response.json({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "create_sprint",
                  arguments: { name: "Sprint utan dublett" },
                },
              },
            ],
          },
        });
      return Response.json({
        message: { role: "assistant", content: "Klart!" },
      });
    }) as typeof fetch;
    const assistant = new Assistant(
        store,
        { url: "http://test", model: "tools", timeout: 1000 },
        request,
      ),
      events: import("../shared/schema.js").ChatEvent[] = [];
    await assistant.chat(
      "Planera en sprint",
      newSession(),
      (e) => events.push(e),
      undefined,
      { board_id: scrum.id },
    );
    assert.equal(store.sprints(scrum.id).length, 1);
    const final = events.find((e) => e.type === "done");
    assert.ok(final?.type === "done");
    assert.equal(final.receipts?.length, 1);
    const sprint = store.sprints(scrum.id)[0];
    store.transitionSprint(sprint.id, "active");
    let attempts = 0;
    const retry = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/show"))
        return Response.json({ capabilities: ["tools"] });
      const body = JSON.parse(String(init?.body));
      if (attempts++ === 0)
        return Response.json({
          message: { role: "assistant", content: "Sprinten är avslutad." },
        });
      if (attempts === 2) {
        assert.ok(
          body.messages.some((m: { content: string }) =>
            m.content.includes("Inget skrivverktyg har lyckats"),
          ),
        );
        return Response.json({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "complete_sprint",
                  arguments: { id: sprint.id },
                },
              },
            ],
          },
        });
      }
      return Response.json({
        message: { role: "assistant", content: "Klart!" },
      });
    }) as typeof fetch;
    const corrected = new Assistant(
      store,
      { url: "http://test", model: "tools", timeout: 1000 },
      retry,
    );
    await corrected.chat(
      "Avsluta sprinten",
      newSession(),
      () => {},
      undefined,
      { board_id: scrum.id, sprint_id: sprint.id },
    );
    assert.equal(store.sprint(sprint.id).status, "completed");
    assert.equal(attempts, 3);
  } finally {
    store.close();
  }
});
