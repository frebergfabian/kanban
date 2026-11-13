import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { AddressInfo } from "node:net";
import { Store } from "../server/store.js";
import { Assistant, newSession } from "../server/ai.js";
import { createApp } from "../server/app.js";
import type { ChatEvent } from "../shared/schema.js";

const config = { url: "http://ollama.test", model: "tools", timeout: 1000 };
const tool = (name: string, args: unknown = {}) => ({
  function: { name, arguments: args },
});
const response = (calls?: ReturnType<typeof tool>[]) =>
  Response.json({
    message: {
      role: "assistant",
      content: "Klart!",
      ...(calls ? { tool_calls: calls } : {}),
    },
  });

test("v1 migration preserves every card, ID, timestamp, status and order, then reopens idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-migrate-")),
    path = join(dir, "old.sqlite");
  const db = new Database(path),
    ids = [randomUUID(), randomUUID(), randomUUID()];
  db.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT CHECK(status IN ('todo','in_progress','done')),priority TEXT,due_date TEXT,position INTEGER,created_at TEXT,updated_at TEXT); CREATE INDEX tasks_order ON tasks(status,position);",
  );
  ids.forEach((id, i) =>
    db
      .prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        "Kort " + i,
        "Bevara beskrivning",
        ["todo", "todo", "done"][i],
        "high",
        "2026-12-01",
        i === 1 ? 1 : 0,
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
      ),
  );
  db.close();
  let store = new Store(path);
  try {
    assert.deepEqual(
      store.list().map((t) => t.id),
      ids,
    );
    assert.equal(store.list()[1].position, 1);
    assert.equal(store.get(ids[2]).status, "done");
    assert.equal(store.get(ids[0]).created_at, "2026-01-01T00:00:00Z");
    assert.equal(store.get(ids[0]).updated_at, "2026-02-01T00:00:00Z");
    assert.match(store.detail(ids[0]).posts[0].content, /tidigare tavlan/);
    const snapshot = store.workspace();
    store.close();
    store = new Store(path);
    assert.deepEqual(store.workspace(), snapshot);
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boards, custom columns, cross-board moves, atomic batches and persistent attributed feeds", () => {
  const store = new Store(":memory:");
  try {
    const first = store.defaultBoardId(),
      second = store.createBoard({
        name: "Hemnät",
        description: "Stabilt nät",
        instructions: "Verifiera varje steg.",
      });
    const review = store.createColumn(second.id, {
      name: "Granskning",
      description: "Testa före leverans",
      position: 2,
    });
    assert.deepEqual(
      store.columns(second.id).map((c) => c.name),
      ["Att göra", "Pågår", "Granskning", "Klart"],
    );
    const task = store.create({
      title: "Konfigurera router",
      description: "Mät svarstid",
      board_id: first,
    });
    const moved = store.update(
      task.id,
      { column_id: review.id, position: 0 },
      "assistant",
    );
    assert.equal(moved.board_id, second.id);
    assert.equal(store.list(first).length, 0);
    assert.match(store.detail(task.id).posts[0].content, /Flyttade/);
    assert.equal(store.detail(task.id).posts[0].author, "assistant");
    store.addPost(task.id, {
      content: "Nätverket fungerar. TLS återstår.",
      kind: "update",
    });
    store.addPost(
      task.id,
      { content: "Förslag: testa certifikatkedjan.", kind: "note" },
      "assistant",
    );
    assert.equal(store.get(task.id).post_count, 2);
    assert.match(store.get(task.id).latest_post!, /certifikat/);
    assert.equal(store.detail(task.id).posts[0].author, "assistant");
    assert.equal(store.search("TLS", second.id, 0, 30).tasks[0].id, task.id);
    assert.equal(store.search("TLS", first, 0, 30).total, 0);
    store.create({ title: "100% klart", board_id: first });
    assert.equal(store.search("%", undefined, 0, 30).total, 1);
    const snapshot = store.workspace(second.id),
      postsBefore = store.detail(task.id).posts;
    assert.throws(() =>
      store.createMany([
        { title: "Rollback", board_id: second.id },
        { title: "Fel", column_id: randomUUID() },
      ]),
    );
    assert.deepEqual(store.workspace(second.id), snapshot);
    assert.deepEqual(store.detail(task.id).posts, postsBefore);
    assert.throws(() =>
      store.create({
        title: "Fel tavla",
        board_id: first,
        column_id: review.id,
      }),
    );
    store.updateColumn(review.id, {
      name: "Verifierat",
      is_done: true,
      position: 0,
    });
    assert.equal(store.columns(second.id)[0].id, review.id);
    assert.equal(store.column(review.id).is_done, true);
    assert.equal(store.get(task.id).column_id, review.id);
    for (let i = 0; i < 40; i++)
      store.addPost(task.id, { content: `Händelse ${i}` });
    const latest = store.detail(task.id),
      older = store.detail(task.id, latest.next_before!);
    assert.equal(latest.posts.length, 30);
    assert.ok(older.posts.length > 0);
    assert.ok(
      !older.posts.some((p) => latest.posts.some((x) => p.id === x.id)),
    );
    store.delete(task.id);
    assert.equal(
      (
        store.db
          .prepare("SELECT count(*) AS n FROM posts WHERE task_id=?")
          .get(task.id) as { n: number }
      ).n,
      0,
    );
  } finally {
    store.close();
  }
});

test("AI gets active board, selected card, instructions and feed; its writes stay on that board", async () => {
  const store = new Store(":memory:");
  const first = store.defaultBoardId(),
    board = store.createBoard({
      name: "Linuxprojekt",
      description: "En trygg server",
      instructions: "Skriv verifierbara kriterier.",
    });
  const task = store.create({ title: "TLS", board_id: board.id });
  store.addPost(task.id, { content: "Blockerad av saknad certifikatkedja." });
  let step = 0,
    customId = "";
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["tools"] });
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /Skriv verifierbara kriterier/);
    assert.match(body.messages[0].content, /certifikatkedja/);
    assert.match(body.messages[0].content, new RegExp(task.id));
    assert.match(body.messages[0].content, /create_tasks/);
    switch (step++) {
      case 0:
        return response([tool("get_board"), tool("get_task", { id: task.id })]);
      case 1:
        return response([
          tool("create_column", {
            name: "Blockerat",
            description: "Väntar på underlag",
          }),
        ]);
      case 2: {
        customId = JSON.parse(body.messages.at(-1).content).column.id;
        return response([
          tool("create_tasks", {
            column_id: customId,
            tasks: [
              {
                title: "Kontrollera certifikat",
                description: "Verifiera full kedja med rätt CA.",
              },
              { title: "Testa TLS" },
            ],
          }),
          tool("add_post", {
            id: task.id,
            content: "Nästa steg: verifiera hela certifikatkedjan.",
            kind: "note",
          }),
        ]);
      }
      default:
        return response();
    }
  }) as typeof fetch;
  const assistant = new Assistant(store, config, request),
    events: ChatEvent[] = [];
  try {
    await assistant.chat(
      "Ordna nästa steg",
      newSession(),
      (e) => events.push(e),
      undefined,
      { board_id: board.id, task_id: task.id },
    );
    assert.equal(store.list(first).length, 0);
    assert.equal(store.list(board.id).length, 3);
    assert.equal(store.get(task.id).post_count, 2);
    assert.equal(store.detail(task.id).posts[0].author, "assistant");
    assert.ok(
      events.some(
        (e) =>
          e.type === "board" &&
          e.workspace?.columns.some((c) => c.id === customId),
      ),
    );
    assert.ok(
      events.some(
        (e) => e.type === "done" && e.message.includes("Publicerade"),
      ),
    );
    await assert.rejects(
      () =>
        assistant.chat("Fel kontext", newSession(), () => {}, undefined, {
          board_id: first,
          task_id: task.id,
        }),
      /annan tavla/,
    );
    const session = newSession();
    session.boardId = board.id;
    assert.throws(() =>
      assistant.execute(
        "add_post",
        { id: task.id, content: "Förfalskad", author: "user" },
        session,
      ),
    );
    assert.throws(() =>
      assistant.execute("delete_board", { board_id: board.id }, session),
    );
  } finally {
    store.close();
  }
});

test("AI creation of a different board, its custom column and cards uses returned IDs and preserves original scope", async () => {
  const store = new Store(":memory:");
  let step = 0,
    created = "";
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["tools"] });
    const body = JSON.parse(String(init?.body));
    if (step++ === 0)
      return response([
        tool("create_board", { name: "Ny plan", instructions: "Små steg" }),
      ]);
    if (step === 2) {
      created = JSON.parse(body.messages.at(-1).content).board.id;
      return response([
        tool("create_column", { board_id: created, name: "Väntar" }),
      ]);
    }
    if (step === 3) {
      const column = JSON.parse(body.messages.at(-1).content).column;
      return response([
        tool("create_tasks", {
          board_id: created,
          column_id: column.id,
          tasks: [{ title: "En" }, { title: "Två" }],
        }),
      ]);
    }
    return response();
  }) as typeof fetch;
  try {
    const assistant = new Assistant(store, config, request);
    await assistant.chat("Skapa en ny plan", newSession(), () => {});
    assert.equal(store.boards().length, 2);
    assert.equal(store.list().length, 0);
    assert.equal(store.list(created).length, 2);
  } finally {
    store.close();
  }
});

test("HTTP board/column/feed APIs validate input and never allow forged activity authors", async (t) => {
  const store = new Store(":memory:"),
    assistant = new Assistant(store, config, (async () => {
      throw new TypeError("offline");
    }) as typeof fetch);
  const server = createApp(store, assistant).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const req = (path: string, method = "GET", data?: unknown) =>
    fetch(base + path, {
      method,
      headers: data ? { "Content-Type": "application/json" } : undefined,
      body: data ? JSON.stringify(data) : undefined,
    });
  const board = (
    await (
      await req("/api/boards", "POST", {
        name: "API-tavla",
        instructions: "Bara relevanta kort",
      })
    ).json()
  ).board;
  const column = (
    await (
      await req(`/api/boards/${board.id}/columns`, "POST", {
        name: "Väntar",
        is_done: false,
      })
    ).json()
  ).column;
  const task = (
    await (
      await req("/api/tasks", "POST", {
        title: "API-kort",
        column_id: column.id,
      })
    ).json()
  ).task;
  assert.equal(
    (
      await req(`/api/tasks/${task.id}/posts`, "POST", {
        content: "Hej",
        author: "assistant",
      })
    ).status,
    400,
  );
  const post = await (
    await req(`/api/tasks/${task.id}/posts`, "POST", {
      content: "Detta är en lägesrapport.",
      kind: "update",
    })
  ).json();
  assert.equal(post.post.author, "user");
  assert.equal(post.workspace.board.id, board.id);
  const detail = await (await req(`/api/tasks/${task.id}`)).json();
  assert.equal(detail.posts[0].content, "Detta är en lägesrapport.");
  assert.equal((await req(`/api/tasks/${task.id}?before=invalid`)).status, 400);
  const renamed = await (
    await req(`/api/columns/${column.id}`, "PATCH", {
      name: "Verifiering",
      position: 1,
    })
  ).json();
  assert.equal(renamed.column.name, "Verifiering");
  const workspace = await (await req(`/api/boards/${board.id}`)).json();
  assert.equal(workspace.tasks.length, 1);
  assert.equal(
    (await req(`/api/boards/${board.id}`, "PATCH", { sql: "DROP" })).status,
    400,
  );
  assert.match(
    (await (await req("/api/ai/help")).json()).guide,
    /arbetsassistent/,
  );
  assert.equal(
    (
      await req("/api/ai/chat", "POST", {
        message: "Läs det här",
        board_id: store.defaultBoardId(),
        task_id: task.id,
      })
    ).status,
    400,
  );
  assert.equal((await (await req("/api/ai/status")).json()).available, false);
  assert.equal(
    (
      await req("/api/tasks", "POST", {
        title: "Fungerar fortfarande",
        board_id: board.id,
      })
    ).status,
    201,
  );
});

test("create_board with initial tasks is atomic and switches only the working context", () => {
  const store = new Store(":memory:"),
    session = newSession(),
    assistant = new Assistant(store, config);
  try {
    const first = store.defaultBoardId();
    session.boardId = first;
    const result = assistant.execute(
      "create_board",
      {
        name: "Samlad plan",
        tasks: [
          { title: "Ett", description: "Gör och verifiera ett steg." },
          { title: "Två" },
        ],
      },
      session,
    );
    assert.equal(result.writes, 3);
    assert.notEqual(session.boardId, first);
    assert.equal(store.list(session.boardId).length, 2);
    assert.equal(store.list(first).length, 0);
    const snapshot = store.boards(),
      revision = store.revision();
    store.db.exec(
      "CREATE TRIGGER fail_initial BEFORE INSERT ON tasks WHEN NEW.title='Fail' BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    assert.throws(
      () =>
        assistant.execute(
          "create_board",
          {
            name: "Rollback-tavla",
            tasks: [{ title: "Kan inte bli kvar" }, { title: "Fail" }],
          },
          session,
        ),
      /test failure/,
    );
    assert.deepEqual(store.boards(), snapshot);
    assert.equal(store.revision(), revision);
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT count(*) AS n FROM tasks WHERE title='Kan inte bli kvar'",
          )
          .get() as { n: number }
      ).n,
      0,
    );
    const task = store.list(session.boardId)[0],
      text = "Långt underlag ".repeat(300) + "Viktig detalj längst ned.";
    const post = store.addPost(task.id, { content: text });
    const detail = assistant.execute("get_task", { id: task.id }, session)
      .result as { posts: { id: string; content_truncated: boolean }[] };
    assert.equal(
      detail.posts.find((p) => p.id === post.id)?.content_truncated,
      true,
    );
    const full = assistant.execute("get_post", { id: post.id }, session)
      .result as { post: { content: string } };
    assert.equal(full.post.content, text);
  } finally {
    store.close();
  }
});

test("AI repairs a failed column reference without repeating a successful board creation", async () => {
  const store = new Store(":memory:");
  let step = 0;
  const events: ChatEvent[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["tools"] });
    const body = JSON.parse(String(init?.body)),
      created = store.boards().find((b) => b.name === "Reparera");
    switch (step++) {
      case 0:
        return response([tool("create_board", { name: "Reparera" })]);
      case 1:
        return response([
          tool("create_tasks", {
            board_id: created!.id,
            column_id: store.columns(store.defaultBoardId())[0].id,
            tasks: [{ title: "Rätt kort" }],
          }),
        ]);
      case 2:
        return response();
      case 3:
        assert.match(body.messages.at(-1).content, /Verktygskontroll/);
        return response([
          tool("create_tasks", {
            board_id: created!.id,
            tasks: [{ title: "Rätt kort" }],
          }),
        ]);
      default:
        return response();
    }
  }) as typeof fetch;
  try {
    await new Assistant(store, config, request).chat(
      "Skapa en ny plan",
      newSession(),
      (e) => events.push(e),
    );
    assert.equal(store.boards().length, 2);
    const created = store.boards().find((b) => b.name === "Reparera")!;
    assert.equal(store.list(created.id).length, 1);
    assert.equal(store.list().length, 0);
    const done = events.find((e) => e.type === "done");
    assert.ok(done?.type === "done");
    assert.doesNotMatch(done.message, /Kunde inte/);
  } finally {
    store.close();
  }
});

test("read-only advice keeps the useful analysis rather than only its trailing offer", async () => {
  const store = new Store(":memory:");
  let step = 0;
  const task = store.create({ title: "TLS" });
  store.addPost(task.id, { content: "Nätverket fungerar. TLS återstår." });
  const request = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["tools"] });
    if (step++ === 0) return response([tool("get_task", { id: task.id })]);
    return Response.json({
      message: {
        role: "assistant",
        content:
          "Nästa steg:\n1. Kontrollera TLS-certifikatet.\n2. Verifiera certifikatkedjan.\n\nVill du att jag ska utföra någon av dessa åtgärder?",
      },
    });
  }) as typeof fetch;
  const events: ChatEvent[] = [];
  try {
    const revision = store.revision();
    await new Assistant(store, config, request).chat(
      "Läs flödet och föreslå nästa steg. Ändra ingenting.",
      newSession(),
      (e) => events.push(e),
      undefined,
      { task_id: task.id },
    );
    const done = events.find((e) => e.type === "done");
    assert.ok(done?.type === "done");
    assert.match(done.message, /Kontrollera TLS/);
    assert.doesNotMatch(done.message, /Vill du att/);
    assert.equal(store.revision(), revision);
  } finally {
    store.close();
  }
});
