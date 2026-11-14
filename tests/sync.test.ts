import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Assistant, newSession } from "../server/ai.js";
import { CalendarService } from "../server/calendar.js";
import { IntegrationSync } from "../server/integration-sync.js";
import { analysisCommand } from "../server/analysis-command.js";
import { createApp } from "../server/app.js";
import type {
  SourceAnalysis,
  SyncDocument,
  SyncFolder,
  SyncPage,
} from "../shared/sync.js";
import { analysisFormat, analysisSchema } from "../shared/sync.js";
import type { ChatEvent } from "../shared/schema.js";

const now = Date.parse("2026-11-13T12:00:00Z");
const doc = (fields: Partial<SyncDocument> = {}): SyncDocument => ({
  kind: "mail",
  external_id: randomUUID(),
  identity: randomUUID(),
  thread_id: null,
  title: "Rapport till projektledaren",
  body: "Kan du skicka rapporten före fredag? Privat råtext som aldrig ska finnas i loggar.",
  body_truncated: false,
  occurred_at: "2026-11-13T09:00:00Z",
  sender: "pm@example.test",
  recipients: ["owner@example.test"],
  owner: "owner@example.test",
  folder: "Inkorg",
  role: "incoming",
  url: null,
  starts_at: null,
  ends_at: null,
  cancelled: false,
  ...fields,
});
const outcome = (fields: Partial<SourceAnalysis> = {}): SourceAnalysis => ({
  category: "question",
  urgency: 65,
  action_required: true,
  confidence: 0.99,
  summary: "Projektledaren efterfrågar rapporten.",
  action_title: "Skicka rapporten",
  action_details: "Sammanställ och skicka rapporten.",
  due_date: "2026-11-14",
  evidence: "Kan du skicka rapporten före fredag?",
  match_task_id: null,
  match_confidence: 0,
  ...fields,
});
const folder: SyncFolder = {
  id: "inbox",
  name: "Inkorg",
  kind: "mail",
  role: "incoming",
};
const empty: SyncPage = {
  documents: [],
  removed: [],
  complete: true,
  cursor: "saved-mail-state",
};

async function fixture(path = ":memory:", key = randomBytes(32)) {
  let clock = now,
    calls = 0;
  const store = new Store(path);
  let classify: (
    source: SyncDocument,
    context: any,
  ) => Promise<SourceAnalysis> = async () => outcome();
  const assistant = new Assistant(
    store,
    { url: "http://ollama.test", model: "test", timeout: 30000 },
    (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.ok(body.format);
      assert.equal(body.tools, undefined);
      assert.equal(body.think, false);
      const context = JSON.parse(body.messages[1].content);
      calls++;
      return Response.json({
        message: {
          content: JSON.stringify(await classify(context.source, context)),
        },
      });
    }) as typeof fetch,
  );
  const calendar = (assistant.calendar = new CalendarService(store, {
    key,
    ews: async () =>
      '<s:Envelope xmlns:s="urn:soap"><s:Body><FindItemResponse><ResponseMessages><FindItemResponseMessage><ResponseCode>NoError</ResponseCode><RootFolder IncludesLastItemInRange="true"><Items/></RootFolder></FindItemResponseMessage></ResponseMessages></FindItemResponse></s:Body></s:Envelope>',
  }));
  let account = calendar.accounts()[0]?.id;
  if (!account)
    account = (
      await calendar.add({
        kind: "onprem",
        name: "Testkonto",
        endpoint: "https://exchange.test/EWS/Exchange.asmx",
        username: "owner@example.test",
        password: "synthetic-password",
        auth: "ntlm",
      })
    ).id;
  calendar.syncFolders = async () => [folder];
  calendar.syncPage = async () => empty;
  const sync = (assistant.sync = new IntegrationSync(assistant, () => clock));
  // Explicitly strip the server-owned since field when changing settings.
  const settings = (enabled: boolean) => {
    const { since: _since, ...value } = sync.settings();
    return { ...value, enabled, account_ids: [account] };
  };
  async function ready() {
    sync.configure(settings(true));
    await sync.produceOne();
    await sync.produceOne();
  }
  return {
    store,
    assistant,
    calendar,
    sync,
    account,
    key,
    ready,
    settings,
    classify: (fn: typeof classify) => {
      classify = fn;
    },
    calls: () => calls,
    advance: (ms = 60000) => {
      clock += ms;
    },
    close: async () => {
      await sync.close();
      calendar.close();
      store.close();
    },
  };
}

test("sync creates once, updates a linked thread and preserves human card fields and encrypted raw source data", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const first = doc({ thread_id: "thread-one" });
    const id = f.sync.ingest(f.account, first);
    assert.equal(await f.sync.analyzeOne(), true);
    const task = f.store.list()[0];
    assert.ok(task);
    assert.equal(f.sync.item(id).analysis?.urgency, 65);
    const posts = f.store.detail(task.id).posts.length;
    f.sync.ingest(f.account, first);
    assert.equal(await f.sync.analyzeOne(), false);
    f.store.db
      .prepare("UPDATE sync_sources SET status='queued' WHERE id=?")
      .run(id);
    await f.sync.analyzeOne();
    assert.equal(f.store.list().length, 1);
    assert.equal(f.store.detail(task.id).posts.length, posts);
    f.store.update(task.id, {
      title: "Min egen titel",
      description: "Mina arbetsanteckningar",
      priority: "high",
      due_date: "2026-11-16",
    });
    f.classify(async () =>
      outcome({
        urgency: 40,
        due_date: "2026-11-20",
        action_details: "Komplettera rapporten med november.",
      }),
    );
    const next = f.sync.ingest(
      f.account,
      doc({ thread_id: "thread-one", occurred_at: "2026-11-13T10:00:00Z" }),
    );
    await f.sync.analyzeOne();
    assert.equal(f.sync.item(next).task_id, task.id);
    assert.equal(f.store.list().length, 1);
    const changed = f.store.get(task.id);
    assert.equal(changed.title, "Min egen titel");
    assert.equal(changed.description, "Mina arbetsanteckningar");
    assert.equal(changed.priority, "high");
    assert.equal(changed.due_date, "2026-11-16");
    assert.ok(
      f.store.detail(task.id).posts.some((p) => p.content.includes("november")),
    );
    const raw = JSON.stringify(
      f.store.db.prepare("SELECT * FROM sync_sources").all(),
    );
    assert.ok(!raw.includes(first.body));
    assert.ok(!raw.includes(first.sender));
    const log = JSON.stringify(f.assistant.knowledge.logs());
    assert.ok(!log.includes(first.body));
    assert.ok(!log.includes(first.sender));
    assert.equal(f.sync.search({ query: "rapporten" }).total, 2);
  } finally {
    await f.close();
  }
});

test("spam, newsletters, information, low-confidence guesses and invented evidence cannot create cards", async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (const category of ["spam", "newsletter", "information"] as const) {
      f.classify(async () => outcome({ category, urgency: 100 }));
      const id = f.sync.ingest(f.account, doc());
      await f.sync.analyzeOne();
      assert.equal(f.sync.item(id).analysis?.urgency, 0);
    }
    const calls = f.calls();
    const junk = f.sync.ingest(f.account, doc({ role: "junk" }));
    await f.sync.analyzeOne();
    assert.equal(f.calls(), calls);
    assert.equal(f.sync.item(junk).analysis?.category, "spam");
    for (const patch of [
      { confidence: 0.4 },
      { evidence: "This is fabricated evidence" },
      { match_task_id: randomUUID(), match_confidence: 1 },
    ]) {
      f.classify(async () => outcome(patch));
      const id = f.sync.ingest(f.account, doc());
      await f.sync.analyzeOne();
      assert.equal(f.sync.item(id).status, "review");
    }
    assert.equal(f.store.list().length, 0);
  } finally {
    await f.close();
  }
});

test("a real candidate is updated; sent replies provide context, refresh earlier classifications and add a single source update", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const task = f.store.create({ title: "Rapport till projektledaren" });
    f.classify(async () =>
      outcome({ match_task_id: task.id, match_confidence: 0.99 }),
    );
    const incoming = f.sync.ingest(
      f.account,
      doc({ thread_id: "answered-thread" }),
    );
    await f.sync.analyzeOne();
    assert.equal(f.store.list().length, 1);
    f.classify(async (source, context) => {
      if (source.role === "incoming")
        assert.ok(
          context.related_sources.some((x: SyncDocument) => x.role === "sent"),
        );
      return outcome({
        category: "information",
        action_required: false,
        summary: "Rapporten har skickats i svaret.",
        urgency: 0,
      });
    });
    f.sync.ingest(
      f.account,
      doc({
        thread_id: "answered-thread",
        role: "sent",
        body: "Här är rapporten du bad om.",
        occurred_at: "2026-11-13T11:00:00Z",
      }),
    );
    await f.sync.analyzeOne();
    await f.sync.analyzeOne();
    assert.equal(f.sync.item(incoming).analysis?.urgency, 0);
    assert.equal(f.store.list().length, 1);
    assert.ok(
      f.store
        .detail(task.id)
        .posts.some((p) => p.content.includes("Rapporten har skickats")),
    );
  } finally {
    await f.close();
  }
});

test("classification and Kanban receipts survive restart and roll back atomically after a failed post", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-sync-test-"));
  const path = join(dir, "test.sqlite"),
    key = randomBytes(32);
  let f = await fixture(path, key);
  try {
    await f.ready();
    const id = f.sync.ingest(f.account, doc());
    const add = f.store.addPost.bind(f.store);
    f.store.addPost = () => {
      throw new Error("Synthetic write failure");
    };
    await f.sync.analyzeOne();
    assert.equal(f.store.list().length, 0);
    assert.equal(
      (
        f.store.db
          .prepare("SELECT count(*) AS n FROM sync_receipts")
          .get() as any
      ).n,
      0,
    );
    f.store.addPost = add;
    f.advance();
    await f.sync.analyzeOne();
    const posts = f.store.detail(f.store.list()[0].id).posts.length;
    f.store.db
      .prepare("UPDATE sync_sources SET status='running' WHERE id=?")
      .run(id);
    await f.close();
    f = await fixture(path, key);
    await f.sync.analyzeOne();
    assert.equal(f.store.list().length, 1);
    assert.equal(f.store.detail(f.store.list()[0].id).posts.length, posts);
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revocation and a changed source during inference prevent stale automatic writes", async () => {
  const f = await fixture();
  try {
    await f.ready();
    let finish!: () => void;
    f.classify(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return outcome();
    });
    const source = doc();
    const id = f.sync.ingest(f.account, source);
    const pending = f.sync.analyzeOne();
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    f.calendar.permissions(f.account, { allow_ai: false });
    finish();
    await pending;
    assert.equal(f.store.list().length, 0);
    assert.throws(() => f.sync.item(id), /inte tillgänglig/);
    f.calendar.permissions(f.account, { allow_ai: true });
    f.advance();
    finish = undefined!;
    const second = f.sync.analyzeOne();
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    f.sync.ingest(f.account, {
      ...source,
      body: "Ny version utan någon fråga.",
    });
    finish();
    await second;
    assert.equal(f.store.list().length, 0);
  } finally {
    await f.close();
  }
});

test("manual latest N chooses N globally, respects date ranges, persists selection and does not auto-analyze extra scan candidates", async () => {
  const f = await fixture();
  try {
    const folders = [
      { ...folder, id: "a" },
      { ...folder, id: "b" },
    ];
    f.calendar.syncFolders = async () => folders;
    f.calendar.syncPage = async (_account, current) => ({
      ...empty,
      documents: Array.from({ length: 25 }, (_, i) =>
        doc({
          external_id: `${current.id}-${i}`,
          identity: `${current.id}-${i}`,
          occurred_at: new Date(
            Date.UTC(2020, 0, 30 - i, current.id === "a" ? 10 : 11),
          ).toISOString(),
        }),
      ),
    });
    const run = f.sync.request({ limit: 10 });
    assert.equal(f.sync.request({ limit: 10 }).id, run.id);
    for (let i = 0; i < 8 && f.sync.run(run.id).status === "indexing"; i++)
      await f.sync.produceOne();
    assert.equal(f.sync.run(run.id).status, "analyzing");
    assert.equal(
      f.sync.run(run.id).counts.reduce((n, x) => n + x.count, 0),
      10,
    );
    for (let i = 0; i < 11; i++) await f.sync.analyzeOne();
    assert.equal(f.calls(), 10);
    assert.equal(f.sync.run(run.id).status, "completed");
    assert.equal(
      (
        f.store.db
          .prepare(
            "SELECT count(*) AS n FROM sync_sources WHERE status='indexed'",
          )
          .get() as any
      ).n,
      40,
    );
    const selected = f.store.db
      .prepare(
        "SELECT s.occurred_at FROM sync_sources s JOIN sync_run_items i ON i.source_id=s.id WHERE run_id=? ORDER BY s.occurred_at DESC",
      )
      .all(run.id) as { occurred_at: string }[];
    assert.equal(selected[0].occurred_at, "2020-01-30T11:00:00.000Z");
    assert.equal(selected[9].occurred_at, "2020-01-26T10:00:00.000Z");
    const filtered = f.sync.request({
      from: "2020-01-29T00:00:00Z",
      to: "2020-01-30T00:00:00Z",
    });
    for (let i = 0; i < 8 && f.sync.run(filtered.id).status === "indexing"; i++)
      await f.sync.produceOne();
    assert.equal(
      f.sync.run(filtered.id).counts.reduce((n, x) => n + x.count, 0),
      2,
    );
  } finally {
    await f.close();
  }
});

test("manual commands queue without an LLM round trip and Swedish weeks respect Stockholm DST", async () => {
  assert.deepEqual(analysisCommand("analysera mina 10 senaste mail"), {
    kind: "mail",
    limit: 10,
  });
  const spring = analysisCommand(
    "analysera mina mail från den här veckan",
    Date.parse("2026-03-29T12:00:00Z"),
  )!;
  assert.equal(spring.from, "2026-03-23T00:00:00.000+01:00");
  assert.equal(spring.to, "2026-03-29T14:00:00.000+02:00");
  assert.equal(
    analysisCommand("sammanfatta ett mejl och radera alla kort"),
    undefined,
  );
  const f = await fixture();
  try {
    const events: ChatEvent[] = [];
    await f.assistant.chat(
      "analysera mina 10 senaste mail",
      newSession(),
      (e) => events.push(e),
    );
    assert.equal(f.calls(), 0);
    assert.ok(events.some((e) => e.type === "done" && /köats/.test(e.message)));
    assert.equal(f.sync.status().runs.length, 1);
    assert.equal(f.store.list().length, 0);
  } finally {
    await f.close();
  }
});

test("sync REST is same-origin guarded and exposes no mail/calendar mutation endpoints", async () => {
  const f = await fixture();
  const app = createApp(f.store, f.assistant),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const response = await fetch(base + "/api/sync/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://external.invalid",
      },
      body: '{"limit":10}',
    });
    assert.equal(response.status, 403);
    const valid = await fetch(base + "/api/sync/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"limit":10}',
    });
    assert.equal(valid.status, 202);
    for (const method of ["POST", "PATCH", "DELETE"])
      assert.equal(
        (
          await fetch(base + "/api/mail/send", {
            method,
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        404,
      );
  } finally {
    await app.locals.integrationSync.close();
    await app.locals.jobQueue.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test("uncertain analysis can improve on reanalysis without repeating an already committed action", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.classify(async () => outcome({ confidence: 0.2 }));
    const id = f.sync.ingest(f.account, doc({ thread_id: "improving" }));
    await f.sync.analyzeOne();
    assert.equal(f.sync.item(id).status, "review");
    f.classify(async () => outcome());
    f.store.db
      .prepare("UPDATE sync_sources SET status='queued' WHERE id=?")
      .run(id);
    await f.sync.analyzeOne();
    assert.equal(f.store.list().length, 1);
    const task = f.store.list()[0];
    const posts = f.store.detail(task.id).posts.length;
    f.store.db
      .prepare("UPDATE sync_sources SET status='queued' WHERE id=?")
      .run(id);
    await f.sync.analyzeOne();
    assert.equal(f.store.detail(task.id).posts.length, posts);
    f.store.delete(task.id);
    const follow = f.sync.ingest(
      f.account,
      doc({ thread_id: "improving", occurred_at: "2026-11-13T11:00:00Z" }),
    );
    await f.sync.analyzeOne();
    assert.equal(f.sync.item(follow).status, "review");
    assert.equal(f.store.list().length, 0);
  } finally {
    await f.close();
  }
});

test("Ollama grammar uses a compatible generation schema while result dates and IDs remain strictly validated", () => {
  assert.ok(!JSON.stringify(analysisFormat).includes('"pattern"'));
  assert.equal(
    analysisSchema.safeParse(outcome({ due_date: "2026-02-30" })).success,
    false,
  );
  assert.equal(
    analysisSchema.safeParse(outcome({ match_task_id: "invented-id" })).success,
    false,
  );
  assert.equal(
    analysisSchema.safeParse(outcome({ urgency: 101 })).success,
    false,
  );
});

test("model evidence IDs resolve to original source text and invented IDs cannot authorize a card", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.classify(async (_source, context) => {
      assert.match(context.source.body, /\[Q1\]/);
      return {
        ...outcome(),
        evidence: undefined,
        evidence_id: "Q1",
      } as unknown as SourceAnalysis;
    });
    const id = f.sync.ingest(f.account, doc());
    await f.sync.analyzeOne();
    assert.equal(
      f.sync.item(id).analysis?.evidence,
      "Kan du skicka rapporten före fredag?",
    );
    assert.equal(f.store.list().length, 1);
    f.classify(
      async () =>
        ({
          ...outcome(),
          evidence: undefined,
          evidence_id: "invented",
        }) as unknown as SourceAnalysis,
    );
    const second = f.sync.ingest(f.account, doc());
    await f.sync.analyzeOne();
    assert.equal(f.sync.item(second).status, "review");
    assert.equal(f.store.list().length, 1);
  } finally {
    await f.close();
  }
});

test("the recent-mail poll continues while delta backfill is unfinished and calendar absence is recorded after a complete window", async () => {
  const f = await fixture();
  try {
    f.calendar.syncFolders = async () => [
      folder,
      { ...folder, kind: "calendar", id: "calendar" },
    ];
    const event = doc({
      kind: "calendar",
      external_id: "event",
      identity: "event",
      starts_at: "2026-11-14T10:00:00Z",
      ends_at: "2026-11-14T11:00:00Z",
      occurred_at: "2026-11-14T10:00:00Z",
    });
    let includeEvent = true;
    f.calendar.syncPage = async (_id, current, _cursor, _from, _to, scan) =>
      current.kind === "calendar"
        ? { ...empty, cursor: null, documents: includeEvent ? [event] : [] }
        : scan
          ? empty
          : { ...empty, cursor: "delta-next", complete: false };
    f.sync.configure(f.settings(true));
    for (let i = 0; i < 6; i++) {
      await f.sync.produceOne();
      f.advance(2000);
    }
    const poll = f.store.db
      .prepare("SELECT id FROM sync_streams WHERE kind='mail_poll'")
      .get() as { id: string };
    assert.ok(poll);
    const source = f.sync.search({ kind: "calendar" }).items[0];
    assert.ok(source);
    includeEvent = false;
    f.advance(600000);
    for (let i = 0; i < 8; i++) {
      await f.sync.produceOne();
      f.advance(2000);
    }
    assert.equal(f.sync.item(source.id).status, "removed");
    const checkpoint = f.store.db
      .prepare("SELECT checkpoint FROM sync_streams WHERE id=?")
      .get(poll.id) as { checkpoint: string };
    const state = f.calendar.openIndex<{ start: string }>(
      `stream:${poll.id}`,
      checkpoint.checkpoint,
    );
    assert.ok(Date.parse(state.start) > now);
  } finally {
    await f.close();
  }
});

test("workflow routes generated proposals to main Inbox and migrates only generated cards, preserving manual work", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const source = f.sync.ingest(f.account, doc());
    await f.sync.analyzeOne();
    const generated = f.store.get(f.sync.item(source).task_id!);
    assert.equal(f.store.column(generated.column_id).key, "inbox");
    const legacy = f.store.createBoard({ name: "Inkorg", kind: "kanban" });
    f.store.update(generated.id, { board_id: legacy.id });
    const manual = f.store.create({
      board_id: legacy.id,
      title: "Manuellt arbete",
    });
    f.store.db
      .prepare("UPDATE sync_config SET settings=? WHERE id=1")
      .run(JSON.stringify({ ...f.sync.settings(), board_id: legacy.id }));
    f.sync.workflow.initialize();
    assert.equal(f.store.get(generated.id).board_id, f.store.defaultBoardId());
    assert.equal(f.store.get(manual.id).board_id, legacy.id);
    assert.equal(f.store.boards().filter((b) => b.name === "Inkorg").length, 1);
    assert.deepEqual(f.sync.workflow.columns().waiting.key, "waiting");
    const rev = f.store.workspace().revision;
    f.sync.workflow.initialize();
    assert.equal(f.store.workspace().revision, rev);
  } finally {
    await f.close();
  }
});

test("rejection preserves history, blocks thread resurrection and gives contextual feedback without globally ignoring sender", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const first = doc({ thread_id: "rejected-thread" }),
      source = f.sync.ingest(f.account, first);
    await f.sync.analyzeOne();
    const id = f.sync.item(source).task_id!,
      postCount = f.store.detail(id).posts.length;
    f.sync.workflow.reject({
      id,
      reason: "Det är bara en statusrapport; jag behöver inte svara.",
    });
    assert.equal(f.store.column(f.store.get(id).column_id).key, "rejected");
    assert.ok(f.store.detail(id).posts.length > postCount);
    assert.equal(f.sync.workflow.canReject(id), false);
    assert.equal(f.sync.workflow.isIgnored(first), false);
    f.sync.ingest(f.account, {
      ...first,
      external_id: "new-id",
      identity: "new-in-thread",
      body: "Kan du skicka rapporten före fredag? Ny påminnelse.",
    });
    for (let i = 0; i < 5; i++) await f.sync.analyzeOne();
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM tasks").get() as any).n,
      1,
    );
    let feedback: any[] = [];
    f.classify(async (_source, context) => {
      feedback = context.rejection_feedback;
      return outcome({ action_required: false, category: "information" });
    });
    f.sync.ingest(f.account, doc({ thread_id: "different-thread" }));
    await f.sync.analyzeOne();
    assert.ok(feedback.some((x) => x.reason.includes("statusrapport")));
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM tasks").get() as any).n,
      1,
    );
    assert.throws(
      () =>
        f.sync.workflow.reject({
          id: f.store.create({ title: "Manuellt" }).id,
          reason: "Fel",
        }),
      /Bara aktiva/,
    );
  } finally {
    await f.close();
  }
});

test("ignore rules short-circuit automatic, manual, in-flight analysis and index reads without leaking bodies", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const ignored = doc({
        sender: "Service <NOREPLY_SERVICEDESK@FINSPANG.SE>",
      }),
      source = f.sync.ingest(f.account, ignored);
    assert.equal(f.sync.item(source).status, "excluded");
    assert.equal(f.sync.item(source).document.body, "");
    assert.equal(await f.sync.analyzeOne(), false);
    assert.equal(f.calls(), 0);
    assert.throws(() => f.sync.item(source, true), /ignorerad/);
    assert.equal(f.sync.search({}).total, 0);
    // Even a manual run cannot bypass the rule.
    f.store.db
      .prepare(
        "UPDATE sync_sources SET status='queued',manual_priority=100 WHERE id=?",
      )
      .run(source);
    await f.sync.analyzeOne();
    assert.equal(f.calls(), 0);
    assert.equal(f.sync.item(source).status, "excluded");
    let resolve!: (value: SourceAnalysis) => void;
    f.classify(
      async () =>
        await new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = doc({ sender: "new@example.test" }),
      pendingId = f.sync.ingest(f.account, pending);
    const work = f.sync.analyzeOne();
    while (!resolve) await new Promise((r) => setTimeout(r, 0));
    const before = f.calls();
    f.sync.workflow.addIgnore({
      sender: pending.sender,
      reason: "Automatisk avisering",
    });
    resolve(outcome());
    await work;
    assert.equal(f.calls(), before);
    assert.equal(f.sync.item(pendingId).status, "excluded");
    assert.equal(f.store.list().length, 0);
    const rule = f.sync.workflow
      .ignores()
      .find((r) => r.sender === pending.sender)!;
    assert.ok(
      !String(
        (
          f.store.db
            .prepare("SELECT payload FROM ignored_senders WHERE id=?")
            .get(rule.id) as any
        ).payload,
      ).includes(pending.sender),
    );
    f.sync.workflow.removeIgnore(rule.id);
    assert.equal(f.sync.workflow.isIgnored(pending), false);
  } finally {
    await f.close();
  }
});

test("calendar attendance, holidays and routine entries never create work; explicit preparation does", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const calendar = doc({
      kind: "calendar",
      title: "Veckomöte",
      body: "Agenda: status och nästa vecka.",
      starts_at: "2026-11-14T09:00:00Z",
      ends_at: "2026-11-14T10:00:00Z",
      occurred_at: "2026-11-14T09:00:00Z",
    });
    for (const title of ["Veckomöte", "Juldagen", "Födelsedag", "Semester"]) {
      f.sync.ingest(f.account, {
        ...calendar,
        identity: randomUUID(),
        external_id: randomUUID(),
        title,
      });
      await f.sync.analyzeOne();
    }
    assert.equal(f.calls(), 0);
    assert.equal(f.store.list().length, 0);
    f.classify(async () =>
      outcome({
        category: "meeting",
        evidence: "Läs igenom underlaget och förbered budgeten.",
        action_title: "Ta fram budgetunderlag",
      }),
    );
    f.sync.ingest(f.account, {
      ...calendar,
      identity: randomUUID(),
      external_id: randomUUID(),
      body: "Läs igenom underlaget och förbered budgeten.",
    });
    await f.sync.analyzeOne();
    assert.equal(f.calls(), 1);
    assert.equal(f.store.list().length, 1);
    // All events are still available as agenda entries, including routine entries.
    assert.equal(f.sync.workflow.daily("2026-11-14").agenda.length, 5);
  } finally {
    await f.close();
  }
});

test("overdue cards enter Backlog while waiting and completed cards retain their state; waiting has reason and follow-up", async () => {
  const f = await fixture();
  try {
    const { backlog, waiting } = f.sync.workflow.columns(),
      main = f.store.defaultBoardId(),
      todo = f.store.columns(main).find((c) => c.key === "todo")!;
    const late = f.store.create({
      title: "Försenat",
      column_id: todo.id,
      due_date: "2026-11-12",
    });
    const wait = f.store.create({
      title: "Leverans",
      column_id: todo.id,
      due_date: "2026-11-12",
    });
    f.sync.workflow.wait({
      id: wait.id,
      reason: "Väntar på leverantören",
      until: "2026-11-16",
    });
    const done = f.store.create({
      title: "Klart",
      column_id: f.store.columns(main).find((c) => c.is_done)!.id,
      due_date: "2026-11-12",
    });
    f.sync.workflow.tick(true);
    assert.equal(f.store.get(late.id).column_id, backlog.id);
    assert.equal(f.store.get(wait.id).column_id, waiting.id);
    assert.equal(f.store.column(f.store.get(done.id).column_id).is_done, true);
    const posts = f.store.detail(late.id).posts.length;
    f.sync.workflow.tick(true);
    assert.equal(f.store.detail(late.id).posts.length, posts);
    assert.equal(
      f.sync.workflow.daily().waiting[0].reason,
      "Väntar på leverantören",
    );
    assert.equal(f.sync.workflow.daily().waiting[0].until_date, "2026-11-16");
  } finally {
    await f.close();
  }
});

test("daily brief is once per Stockholm date at 06:00, survives restart, handles DST, and uses actual completions", async () => {
  const f = await fixture();
  try {
    f.advance(Date.parse("2026-10-24T03:59:00Z") - now); // 05:59 CEST
    f.sync.workflow.tick(true);
    assert.equal(f.sync.workflow.daily().brief, null);
    f.advance(60000);
    f.sync.workflow.tick(true);
    assert.ok(f.sync.workflow.daily().brief);
    assert.equal(
      f.sync.workflow.daily().next_at,
      "2026-10-25T06:00:00.000+01:00",
    );
    const created = f.sync.workflow.daily().created_at;
    f.sync.workflow.tick(true);
    assert.equal(f.sync.workflow.daily().created_at, created);
    f.advance(25 * 3600000); // 06:00 CET after fallback
    f.sync.workflow.tick(true);
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM daily_briefs").get() as any)
        .n,
      2,
    );
    const restarted = new IntegrationSync(f.assistant, () =>
      Date.parse("2026-10-25T07:00:00Z"),
    );
    restarted.workflow.tick(true);
    await restarted.close();
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM daily_briefs").get() as any)
        .n,
      2,
    );
    f.advance(
      Date.parse("2026-11-14T05:00:00Z") - Date.parse("2026-10-25T05:00:00Z"),
    );
    const t = f.store.create({ title: "Verkligt resultat" });
    f.store.update(t.id, {
      column_id: f.store
        .columns(f.store.defaultBoardId())
        .find((c) => c.is_done)!.id,
    });
    f.store.db
      .prepare("UPDATE task_transitions SET created_at=? WHERE task_id=?")
      .run("2026-11-13T15:00:00.000Z", t.id);
    f.sync.workflow.tick(true);
    assert.equal(
      f.sync.workflow.daily("2026-11-14").brief?.yesterday.completed[0].title,
      "Verkligt resultat",
    );
  } finally {
    await f.close();
  }
});

test("workflow write tools require an actual human instruction, count writes, and reject external-source authority", async () => {
  const f = await fixture();
  try {
    const session = newSession();
    await assert.rejects(
      () =>
        f.assistant.executeTool(
          "add_ignored_sender",
          { sender: "bad@example.test" },
          session,
        ),
      /uttryckligen/,
    );
    session.userRequest = "Sammanfatta det här mejlet";
    session.externalSelected = true;
    await assert.rejects(
      () =>
        f.assistant.executeTool(
          "add_ignored_sender",
          { sender: "bad@example.test" },
          session,
        ),
      /uttryckligen/,
    );
    session.externalSelected = false;
    session.userRequest = "Ignorera bad@example.test";
    const result = await f.assistant.executeTool(
      "add_ignored_sender",
      { sender: "bad@example.test" },
      session,
    );
    assert.equal(result.writes, 1);
    assert.equal(result.changed, true);
    assert.ok(
      f.sync.workflow.isIgnored({ kind: "mail", sender: "bad@example.test" }),
    );
  } finally {
    await f.close();
  }
});

test("a master card enters Backlog when an active Scrum subtask is overdue, but not while the parent waits", async () => {
  const f = await fixture();
  try {
    const parent = f.store.create({ title: "Masterkort" });
    const child = f.store.createBoard({
      name: "Underarbete",
      kind: "scrum",
      parent_task_id: parent.id,
    });
    f.store.create({
      board_id: child.id,
      title: "Försenat delarbete",
      due_date: "2026-11-12",
    });
    f.sync.workflow.tick(true);
    assert.equal(
      f.store.column(f.store.get(parent.id).column_id).key,
      "overdue",
    );
    assert.ok(
      f.store
        .detail(parent.id)
        .posts.some((p) => p.content.includes("underuppgiften")),
    );
    f.sync.workflow.wait({
      id: parent.id,
      reason: "Inväntar beslut",
      until: null,
    });
    f.sync.workflow.tick(true);
    assert.equal(
      f.store.column(f.store.get(parent.id).column_id).key,
      "waiting",
    );
    assert.equal(
      f.sync.workflow.taskInfo(parent.id).waiting?.reason,
      "Inväntar beslut",
    );
  } finally {
    await f.close();
  }
});

test("ordinary analysis cannot remove an ignore rule and AI mail tools exclude ignored messages", async () => {
  const f = await fixture();
  try {
    const rule = f.sync.workflow.ignores()[0],
      session = newSession();
    session.userRequest = "Analysera mina tio senaste mejl";
    await assert.rejects(
      () =>
        f.assistant.executeTool(
          "remove_ignored_sender",
          { id: rule.id },
          session,
        ),
      /uttryckligen/,
    );
    f.calendar.searchMail = async () => ({
      messages: [
        {
          id: "blocked",
          account_id: f.account,
          subject: "Ignorerad",
          from: { address: rule.sender, name: "Test" },
          to: [],
          cc: [],
          received_at: new Date(now).toISOString(),
          preview: "Ska inte lämnas till AI",
          is_read: false,
          has_attachments: false,
          conversation_id: null,
          url: null,
        },
      ],
      next_offset: null,
      fetched_at: new Date(now).toISOString(),
    });
    f.calendar.getMail = async () => ({
      ...(await f.calendar.searchMail({})).messages[0],
      body: "Hemlig testtext",
      body_truncated: false,
    });
    const result = await f.assistant.executeTool(
      "search_mail",
      { account_id: f.account },
      session,
    );
    assert.equal((result.result.messages as unknown[]).length, 0);
    await assert.rejects(
      () =>
        f.assistant.executeTool(
          "get_mail",
          { account_id: f.account, message_id: "blocked" },
          session,
        ),
      /ignore-listan/,
    );
    session.userRequest = `Ta bort ignore-regeln för ${rule.sender}`;
    await f.assistant.executeTool(
      "remove_ignored_sender",
      { id: rule.id },
      session,
    );
    assert.equal(f.sync.workflow.ignores().length, 0);
  } finally {
    await f.close();
  }
});
