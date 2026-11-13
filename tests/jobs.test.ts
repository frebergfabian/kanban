import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Assistant } from "../server/ai.js";
import { JobQueue } from "../server/jobs.js";
import { scrub } from "../server/knowledge.js";
import { createApp } from "../server/app.js";
import type { AddressInfo } from "node:net";
const config = { url: "http://test", model: "tools", timeout: 2000 };
const response = (name?: string, args?: unknown, content = "Klart!") =>
  Response.json({
    message: {
      role: "assistant",
      content: name ? "" : content,
      ...(name
        ? { tool_calls: [{ function: { name, arguments: args } }] }
        : {}),
    },
    prompt_eval_count: 100,
    eval_count: 20,
  });
const context = (body: any) =>
  JSON.parse(
    body.messages[0].content.split(
      "\nAKTUELL SERVERKONTEXT (ersätter äldre tillstånd):\n",
    )[1],
  );
async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Timed out waiting for worker");
}
const fakeCreate = (
  hold?: () => Promise<void>,
  inspect?: (body: any) => void,
) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["tools"] });
    const body = JSON.parse(String(init?.body));
    inspect?.(body);
    if (body.messages.at(-1).role === "tool") return response();
    if (hold) await hold();
    return response("create_task", {
      title: body.messages.filter((m: any) => m.role === "user").at(-1).content,
    });
  }) as typeof fetch;

test("durable serial queue: idempotency, reorder, cancel queued, live receipts and current context", async () => {
  const store = new Store(":memory:");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let first = true,
    concurrent = 0,
    max = 0,
    isolated = false;
  const request = fakeCreate(
    async () => {
      concurrent++;
      max = Math.max(max, concurrent);
      if (first) {
        first = false;
        await gate;
      }
      concurrent--;
    },
    (body) => {
      const users = body.messages.filter((m: any) => m.role === "user");
      if (users.at(-1)?.content === "Fjärde jobbet")
        isolated = !users
          .slice(0, -1)
          .some((m: any) => m.content.includes("Andra jobbet"));
    },
  );
  const assistant = new Assistant(store, config, request),
    q = new JobQueue(assistant),
    k = assistant.knowledge;
  try {
    const input = { message: "Första jobbet", request_id: randomUUID() };
    const a = q.submit(input);
    assert.equal(q.submit(input).id, a.id);
    assert.throws(() => new JobQueue(assistant), /andra instans/);
    await waitFor(() => k.job(a.id).status === "running");
    assert.throws(() => q.protectBoard(store.defaultBoardId()), /jobb/);
    const b = q.submit({
        message: "Andra jobbet",
        request_id: randomUUID(),
        conversation_id: a.conversation_id,
      }),
      c = q.submit({
        message: "Tredje jobbet",
        request_id: randomUUID(),
        conversation_id: a.conversation_id,
      }),
      d = q.submit({
        message: "Fjärde jobbet",
        request_id: randomUUID(),
        conversation_id: a.conversation_id,
      });
    q.move(d.id, "up");
    q.cancel(c.id);
    q.move(d.id, "up");
    assert.deepEqual(
      k
        .jobs()
        .filter((j) => j.status === "queued")
        .map((j) => j.id),
      [d.id, b.id],
    );
    release();
    await waitFor(() => k.job(b.id).status === "completed");
    assert.deepEqual(
      store.list().map((t) => t.title),
      ["Första jobbet", "Fjärde jobbet", "Andra jobbet"],
    );
    assert.equal(max, 1);
    assert.ok(
      isolated,
      "A running turn must not see future queued user messages.",
    );
    assert.equal(k.job(c.id).status, "cancelled");
    assert.equal(k.job(a.id).receipts.length, 1);
    assert.equal(k.messages(a.conversation_id).messages.length, 8);
    assert.ok(
      k
        .logs({ job_id: a.id })
        .logs.some(
          (l) => l.event === "model.round" && l.detail.includes("100"),
        ),
    );
  } finally {
    release();
    await q.close();
    store.close();
  }
});
test("memory has user provenance, is recalled across conversations, can be corrected/forgotten and redacts secrets", async () => {
  const store = new Store(":memory:");
  let recalled = false;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["tools"] });
    const body = JSON.parse(String(init?.body)),
      ctx = context(body),
      message = body.messages
        .filter((m: any) => m.role === "user")
        .at(-1).content;
    if (body.messages.at(-1).role === "tool") return response();
    if (message.includes("Kom ihåg"))
      return response("save_memory", {
        key: "språk",
        content: "Användaren föredrar svenska svar.",
        kind: "preference",
        scope: "global",
        source_message_id: ctx.current_user_message.id,
      });
    recalled = ctx.remembered.memories.some((m: any) => m.key === "språk");
    return response(undefined, undefined, "Du föredrar svenska svar.");
  }) as typeof fetch;
  const assistant = new Assistant(store, config, request),
    q = new JobQueue(assistant),
    k = assistant.knowledge;
  try {
    const a = q.submit({
      message: "Kom ihåg att jag föredrar svenska svar.",
      request_id: randomUUID(),
    });
    await waitFor(() => k.job(a.id).status === "completed");
    const memory = k.memories()[0];
    assert.ok(memory.source_message_id);
    assert.equal(
      k.messages(a.conversation_id).messages[0].id,
      memory.source_message_id,
    );
    const b = q.submit({
      message: "Vilket språk föredrar jag?",
      request_id: randomUUID(),
    });
    await waitFor(() => k.job(b.id).status === "completed");
    assert.ok(recalled);
    assert.equal(k.searchConversations("föredrar").messages.length >= 2, true);
    k.saveMemory({
      key: "språk",
      content: "Föredrar nu engelska.",
      kind: "preference",
      board_id: null,
      source: "manual",
    });
    assert.equal(k.memories().length, 1);
    assert.match(k.memory(memory.id).content, /engelska/);
    k.forget(memory.id);
    assert.equal(k.memories().length, 0);
    assert.throws(
      () =>
        k.saveMemory({
          key: "secret",
          content: "token=abc123",
          kind: "fact",
          board_id: null,
          source: "manual",
        }),
      /Hemligheter/,
    );
    assert.throws(
      () =>
        k.saveMemory({
          key: "fake",
          content: "Falskt",
          kind: "fact",
          board_id: null,
          source: "conversation",
          source_message_id: randomUUID(),
        }),
      /användarmeddelande/,
    );
    k.log("test.redaction", {
      token: "DO-NOT-LOG",
      nested: { password: "HIDDEN" },
      prompt_tokens: 100,
      text: "api_key=HIDDEN",
    });
    const log = k.logs({ query: "test.redaction" }).logs[0];
    assert.doesNotMatch(log.detail, /DO-NOT-LOG|HIDDEN/);
    assert.match(log.detail, /100/);
    assert.equal(scrub("token=abc"), "token=[REDACTED]");
  } finally {
    await q.close();
    store.close();
  }
});
test("restart preserves memory/history, interrupts running work without replay and resumes queued work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobs-restart-")),
    path = join(dir, "db.sqlite");
  let store = new Store(path),
    assistant = new Assistant(store, config, fakeCreate()),
    q = new JobQueue(assistant);
  try {
    const a = q.submit({
        message: "Får inte upprepas",
        request_id: randomUUID(),
      }),
      b = q.submit({ message: "Köat efter omstart", request_id: randomUUID() });
    store.create({ title: "Redan sparat delsteg" });
    store.db
      .prepare("UPDATE ai_jobs SET status='running',receipts=? WHERE id=?")
      .run(JSON.stringify(["Skapade delsteget."]), a.id);
    assistant.knowledge.saveMemory({
      key: "Beslut",
      content: "Bevara beständigt.",
      kind: "decision",
      board_id: null,
      source: "manual",
    });
    await q.close();
    store.close();
    store = new Store(path);
    assistant = new Assistant(store, config, fakeCreate());
    q = new JobQueue(assistant);
    await waitFor(() => assistant.knowledge.job(b.id).status === "completed");
    assert.equal(assistant.knowledge.job(a.id).status, "interrupted");
    assert.equal(assistant.knowledge.job(a.id).receipts.length, 1);
    assert.deepEqual(
      store.list().map((t) => t.title),
      ["Redan sparat delsteg", "Köat efter omstart"],
    );
    assert.equal(assistant.knowledge.memories().length, 1);
    assert.ok(
      assistant.knowledge
        .messages(a.conversation_id)
        .messages.some((m) => m.content.includes("startades om")),
    );
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
  } finally {
    await q.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("running cancellation keeps completed writes, receipts and tool error lessons", async () => {
  const store = new Store(":memory:");
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["tools"] });
    const body = JSON.parse(String(init?.body));
    if (body.messages.at(-1).role === "tool")
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    return response("create_task", { title: "Sparat innan avbrottet" });
  }) as typeof fetch;
  const assistant = new Assistant(store, config, request),
    q = new JobQueue(assistant),
    k = assistant.knowledge;
  try {
    const job = q.submit({
      message: "Skapa ett kort",
      request_id: randomUUID(),
    });
    await waitFor(() => k.job(job.id).receipts.length === 1);
    q.cancel(job.id);
    await waitFor(() => k.job(job.id).result.length > 0);
    assert.equal(k.job(job.id).status, "cancelled");
    assert.equal(store.list().length, 1);
    assert.equal(k.job(job.id).receipts.length, 1);
    k.lesson("move_task", "Kolumn-ID saknas.", job.id);
    assert.ok(k.memories().some((m) => m.kind === "lesson"));
  } finally {
    await q.close();
    store.close();
  }
});
test("HTTP queue survives disconnected submit, asks questions, persists approvals and safely deletes boards", async (t) => {
  const store = new Store(":memory:");
  let mode = "question";
  const assistant = new Assistant(store, config, (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["tools"] });
    const body = JSON.parse(String(init?.body));
    if (body.messages.at(-1).role === "tool") return response();
    if (mode === "delete")
      return response("request_delete_board", {
        board_id: context(body).active_board_id,
      });
    return response(undefined, undefined, "Vilken server vill du arbeta med?");
  }) as typeof fetch);
  const app = createApp(store, assistant),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const queue = app.locals.jobQueue as JobQueue;
  t.after(async () => {
    await queue.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
  const first = await post("/api/ai/jobs", {
    message: "Hjälp mig",
    request_id: randomUUID(),
  });
  assert.equal(first.status, 202);
  const { job } = await first.json();
  await waitFor(() => assistant.knowledge.job(job.id).status === "needs_input");
  assert.equal((await fetch(base + "/api/ai/work")).status, 200);
  const board = store.createBoard({ name: "Tillfällig" });
  store.create({ title: "Ett kort", board_id: board.id });
  mode = "delete";
  const deletion = (
    await (
      await post("/api/ai/jobs", {
        message: "Ta bort denna tavla",
        board_id: board.id,
        request_id: randomUUID(),
      })
    ).json()
  ).job;
  await waitFor(
    () => assistant.knowledge.job(deletion.id).status === "needs_input",
  );
  const proposal = assistant.knowledge.pending()[0];
  assert.equal(proposal.kind, "board");
  assert.equal(store.board(board.id).task_count, 1);
  assert.equal(
    (await post(`/api/ai/confirmations/${proposal.id}`, { approve: true }))
      .status,
    200,
  );
  assert.throws(() => store.board(board.id));
  assert.equal(assistant.knowledge.job(deletion.id).status, "completed");
  assert.deepEqual(store.db.pragma("foreign_key_check"), []);
  const master = store.create({ title: "Master" }),
    scrum = store.createBoard({
      name: "Kopplad",
      kind: "scrum",
      parent_task_id: master.id,
    });
  assert.throws(() => store.deleteBoard(master.board_id), /Frikoppla/);
  store.deleteBoard(scrum.id);
  assert.equal(store.get(master.id).child_board, null);
  store.deleteBoard(master.board_id);
  assert.equal(store.boards().length, 1);
  assert.equal(store.list().length, 0);
});
