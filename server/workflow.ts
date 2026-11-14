import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  calendarNeedsPreparation,
  ignoredSender,
  rejectCard,
  senderAddress,
  waitingCard,
} from "../shared/workflow.js";
import type { SyncDocument } from "../shared/sync.js";
import type { IntegrationSync } from "./integration-sync.js";
import { HttpError } from "./store.js";

const zone = "Europe/Stockholm";
type Feedback = {
  id: string;
  task_id: string | null;
  account_id: string;
  sender_hash: string;
  thread_hash: string;
  identity_hash: string;
  payload: string;
  created_at: string;
  origin: string;
};
export class Workflow {
  private nextTick = 0;
  constructor(
    readonly sync: IntegrationSync,
    private clock = () => Date.now(),
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ignored_senders(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS card_feedback(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,sender_hash TEXT NOT NULL,thread_hash TEXT NOT NULL,identity_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS feedback_sender ON card_feedback(sender_hash,created_at);
      CREATE INDEX IF NOT EXISTS feedback_thread ON card_feedback(thread_hash);
      CREATE TABLE IF NOT EXISTS card_waiting(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,reason TEXT NOT NULL,until_date TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_briefs(day TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO workflow_meta VALUES('tracking_from',?)")
      .run(this.time());
    if (
      !this.db
        .prepare("SELECT 1 FROM workflow_meta WHERE key='ignore_seed'")
        .get()
    ) {
      this.db.transaction(() => {
        this.addIgnore({
          sender: "noreply_servicedesk@finspang.se",
          reason: "Undantas enligt användarens önskemål.",
        });
        this.db
          .prepare("INSERT INTO workflow_meta VALUES('ignore_seed','1')")
          .run();
      })();
    }
  }
  private get assistant() {
    return this.sync.assistant;
  }
  private get store() {
    return this.assistant.store;
  }
  private get db() {
    return this.store.db;
  }
  private get calendar() {
    return this.assistant.calendar!;
  }
  private now() {
    return DateTime.fromMillis(this.clock(), { zone });
  }
  private time() {
    return new Date(this.clock()).toISOString();
  }
  private log(event: string, data: Record<string, unknown>) {
    this.assistant.knowledge.log(`workflow.${event}`, data);
  }
  private allowed(id: string) {
    return this.calendar.accounts(true).some((a) => a.id === id && a.connected);
  }
  ignores() {
    return (
      this.db
        .prepare("SELECT * FROM ignored_senders ORDER BY created_at,id")
        .all() as { id: string; payload: string; created_at: string }[]
    ).map((r) => ({
      id: r.id,
      ...this.calendar.openIndex<{ sender: string; reason: string }>(
        `ignore:${r.id}`,
        r.payload,
      ),
      created_at: r.created_at,
    }));
  }
  isIgnored(doc: Pick<SyncDocument, "kind" | "sender">) {
    return (
      doc.kind === "mail" &&
      !!this.db
        .prepare("SELECT 1 FROM ignored_senders WHERE id=?")
        .get(this.calendar.indexHash(`ignore:${senderAddress(doc.sender)}`))
    );
  }
  addIgnore(value: unknown) {
    const input = ignoredSender.parse(value),
      sender = senderAddress(input.sender),
      id = this.calendar.indexHash(`ignore:${sender}`);
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO ignored_senders VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        )
        .run(
          id,
          this.calendar.sealIndex(`ignore:${id}`, { ...input, sender }),
          this.time(),
        );
      // Drop existing analysis/search terms immediately, including any in-flight item.
      for (const r of this.db
        .prepare(
          "SELECT id,payload FROM sync_sources WHERE kind='mail' AND status!='excluded'",
        )
        .all() as { id: string; payload: string }[]) {
        const doc = this.calendar.openIndex<SyncDocument>(
          `source:${r.id}`,
          r.payload,
        );
        if (senderAddress(doc.sender) === sender) this.exclude(r.id, doc);
      }
      this.db
        .prepare("UPDATE metadata SET revision=revision+1 WHERE id=1")
        .run();
    })();
    this.log("ignore_added", { rule_id: id });
    return this.ignores();
  }
  removeIgnore(id: string) {
    this.db.prepare("DELETE FROM ignored_senders WHERE id=?").run(
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(id),
    );
    // No automatic historical replay: an explicit new analysis or source update is needed.
    this.log("ignore_removed", { rule_id: id });
    return this.ignores();
  }
  exclude(id: string, document: SyncDocument) {
    const doc = { ...document, body: "", body_truncated: true };
    this.db
      .prepare(
        "UPDATE sync_sources SET status='excluded',analysis=NULL,category=NULL,urgency=0,manual_priority=0,last_error=NULL,payload=? WHERE id=?",
      )
      .run(this.calendar.sealIndex(`source:${id}`, doc), id);
    this.db.prepare("DELETE FROM sync_terms WHERE source_id=?").run(id);
  }
  private column(
    board: string,
    name: string,
    key: string,
    position?: number,
    done = false,
  ) {
    let col = this.store
      .columns(board)
      .find(
        (c) =>
          c.key === key ||
          c.name.toLocaleLowerCase("sv") === name.toLocaleLowerCase("sv"),
      );
    if (!col)
      col = this.store.createColumn(board, {
        name,
        description:
          key === "waiting"
            ? "Väntar på svar, leverans eller utförandedatum."
            : key === "overdue"
              ? "Aktiva kort vars förfallodatum har passerat."
              : "Nya AI-förslag att granska.",
        is_done: done,
        position,
      });
    // Stable semantic roles also drive colours and tools; Scrum backlog keeps its own key.
    if (col.key !== key)
      this.db.prepare("UPDATE columns SET key=? WHERE id=?").run(key, col.id);
    return this.store.column(col.id);
  }
  inbox() {
    return this.column(this.store.defaultBoardId(), "Inkorg", "inbox", 0);
  }
  columns() {
    const main = this.store.defaultBoardId();
    return {
      inbox: this.inbox(),
      backlog: this.column(main, "Backlog", "overdue", 1),
      waiting: this.column(main, "Väntar", "waiting"),
    };
  }
  private archiveColumn() {
    const main = this.store.defaultBoardId();
    const board =
      this.store.boards().find((b) => b.name === "Inkorg" && b.id !== main) ??
      this.store.createBoard({
        name: "Inkorg",
        kind: "kanban",
        description: "Historik och avvisade AI-förslag.",
      });
    return this.column(board.id, "Avvisat", "rejected", undefined, true);
  }
  initialize() {
    this.db.transaction(() => {
      this.columns();
      if (
        this.db
          .prepare("SELECT 1 FROM workflow_meta WHERE key='main_inbox_v1'")
          .get()
      )
        return;
      const settings = this.sync.settings(),
        main = this.store.defaultBoardId(),
        inbox = this.inbox();
      const cards = this.db
        .prepare(
          "SELECT DISTINCT r.task_id FROM sync_receipts r WHERE r.action='created' AND r.task_id IS NOT NULL",
        )
        .all() as { task_id: string }[];
      for (const { task_id: id } of cards) {
        const task = this.store.get(id);
        const sources = this.db
          .prepare(
            "SELECT id,account_id,payload FROM sync_sources WHERE task_id=?",
          )
          .all(id) as { id: string; account_id: string; payload: string }[];
        const docs = sources.map((r) =>
          this.calendar.openIndex<SyncDocument>(`source:${r.id}`, r.payload),
        );
        // Archive obsolete generated proposals, preserving all card content/history.
        if (
          docs.length &&
          docs.every(
            (d) =>
              this.isIgnored(d) ||
              (d.kind === "calendar" &&
                !calendarNeedsPreparation(d, this.clock())),
          )
        ) {
          this.reject(
            {
              id,
              reason:
                "Regeländring: avsändaren ignoreras eller kalenderobjektet kräver ingen konkret förberedelse.",
            },
            "system",
          );
          continue;
        }
        if (task.board_id === settings.board_id && task.board_id !== main) {
          const old = this.store.column(task.column_id);
          const target = old.is_done
            ? (this.store.columns(main).find((c) => c.is_done) ?? inbox)
            : inbox;
          this.store.update(id, { column_id: target.id }, "assistant");
        }
      }
      this.db
        .prepare("UPDATE sync_config SET settings=? WHERE id=1")
        .run(JSON.stringify({ ...settings, board_id: main }));
      this.db
        .prepare("INSERT INTO workflow_meta VALUES('main_inbox_v1',?)")
        .run(this.time());
      this.log("initialized", { main_board_id: main, reviewed: cards.length });
    })();
  }
  taskInfo(id: string) {
    const task = this.store.get(id),
      waiting =
        this.store.column(task.column_id).key === "waiting"
          ? (this.db
              .prepare(
                "SELECT reason,until_date FROM card_waiting WHERE task_id=?",
              )
              .get(id) as
              | { reason: string; until_date: string | null }
              | undefined)
          : undefined;
    return {
      can_reject: this.canReject(id),
      rejected: this.rejectedTask(id),
      waiting: waiting ?? null,
    };
  }
  canReject(id: string) {
    return (
      !!this.db
        .prepare(
          "SELECT 1 FROM sync_receipts WHERE task_id=? AND action='created' LIMIT 1",
        )
        .get(id) &&
      !this.db
        .prepare("SELECT 1 FROM card_feedback WHERE task_id=? LIMIT 1")
        .get(id)
    );
  }
  isRejected(thread: string, identity: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM card_feedback WHERE thread_hash=? OR identity_hash=? LIMIT 1",
      )
      .get(thread, identity);
  }
  rejectedTask(id: string) {
    return !!this.db
      .prepare("SELECT 1 FROM card_feedback WHERE task_id=? LIMIT 1")
      .get(id);
  }
  reject(value: unknown, origin: "user" | "system" = "user") {
    const { id, reason } = rejectCard.parse(value);
    if (!this.canReject(id))
      throw new HttpError(
        409,
        "Bara aktiva kort som synken har skapat kan avvisas.",
      );
    this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM sync_sources WHERE task_id=?")
        .all(id) as {
        id: string;
        account_id: string;
        payload: string;
        thread_hash: string;
        identity_hash: string;
      }[];
      for (const r of rows) {
        const doc = this.calendar.openIndex<SyncDocument>(
            `source:${r.id}`,
            r.payload,
          ),
          feedbackId = randomUUID();
        this.db
          .prepare("INSERT INTO card_feedback VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            feedbackId,
            id,
            r.account_id,
            this.calendar.indexHash(`sender:${senderAddress(doc.sender)}`),
            r.thread_hash,
            r.identity_hash,
            this.calendar.sealIndex(`feedback:${feedbackId}`, {
              reason,
              title: doc.title,
              sender: doc.sender,
              kind: doc.kind,
            }),
            this.time(),
            origin,
          );
        this.db
          .prepare(
            "UPDATE sync_sources SET status=CASE WHEN status='excluded' THEN status ELSE 'rejected' END,urgency=0,manual_priority=0 WHERE id=?",
          )
          .run(r.id);
      }
      this.store.addPost(
        id,
        {
          kind: "note",
          content: `${origin === "user" ? "Avvisat av användaren" : "Arkiverat enligt ny regel"}: ${reason}\nSamma källtråd skapar inte kortet igen. Avvisning är inte samma sak som att ignorera alla mejl från avsändaren.`,
        },
        origin === "system" ? "assistant" : origin,
      );
      this.store.update(
        id,
        { column_id: this.archiveColumn().id },
        origin === "system" ? "assistant" : origin,
      );
      this.log("card_rejected", {
        task_id: id,
        origin,
        source_count: rows.length,
      });
    })();
    return { id, rejected: true };
  }
  feedback(doc: SyncDocument, accountId: string) {
    return (
      this.db
        .prepare(
          "SELECT * FROM card_feedback WHERE account_id=? AND sender_hash=? AND origin='user' ORDER BY created_at DESC LIMIT 6",
        )
        .all(
          accountId,
          this.calendar.indexHash(`sender:${senderAddress(doc.sender)}`),
        ) as Feedback[]
    ).map((r) => {
      const f = this.calendar.openIndex<{
        reason: string;
        title: string;
        kind: string;
      }>(`feedback:${r.id}`, r.payload);
      return {
        reason: f.reason.slice(0, 500),
        title: f.title.slice(0, 300),
        kind: f.kind,
      };
    });
  }
  feedbackList() {
    return (
      this.db
        .prepare(
          "SELECT * FROM card_feedback ORDER BY created_at DESC LIMIT 100",
        )
        .all() as Feedback[]
    )
      .filter((r) => this.allowed(r.account_id))
      .map((r) => ({
        id: r.id,
        task_id: r.task_id,
        origin: r.origin,
        created_at: r.created_at,
        ...this.calendar.openIndex<{
          reason: string;
          title: string;
          sender: string;
        }>(`feedback:${r.id}`, r.payload),
      }));
  }
  wait(value: unknown) {
    const { id, reason, until } = waitingCard.parse(value),
      task = this.store.get(id);
    const target =
      task.board_id === this.store.defaultBoardId()
        ? this.columns().waiting
        : this.column(task.board_id, "Väntar", "waiting");
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO card_waiting VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET reason=excluded.reason,until_date=excluded.until_date,created_at=excluded.created_at",
        )
        .run(id, reason, until, this.time());
      this.store.addPost(
        id,
        {
          kind: "note",
          content: `Väntar: ${reason}${until ? `\nUppföljningsdatum: ${until}` : ""}`,
        },
        "assistant",
      );
      this.store.update(id, { column_id: target.id }, "assistant");
    })();
    return this.store.get(id);
  }
  tick(force = false) {
    if (!force && this.clock() < this.nextTick) return false;
    this.nextTick = (Math.floor(this.clock() / 60000) + 1) * 60000;
    const today = this.now().toISODate()!,
      { backlog } = this.columns();
    this.db.transaction(() => {
      for (const task of this.store.list(this.store.defaultBoardId())) {
        const col = this.store.column(task.column_id);
        const lateChild = task.child_board
          ? this.store
              .list(task.child_board.id)
              .find(
                (t) =>
                  t.due_date &&
                  t.due_date < today &&
                  !this.store.column(t.column_id).is_done &&
                  this.store.column(t.column_id).key !== "waiting",
              )
          : undefined;
        if (
          !col.is_done &&
          !["waiting", "overdue", "rejected"].includes(col.key) &&
          ((task.due_date && task.due_date < today) || lateChild)
        ) {
          this.store.update(task.id, { column_id: backlog.id }, "assistant");
          this.store.addPost(
            task.id,
            {
              kind: "note",
              content: `Flyttat till Backlog: ${lateChild ? `underuppgiften ”${lateChild.title}” har passerat ${lateChild.due_date}` : `förfallodatum ${task.due_date} har passerat`}.`,
            },
            "assistant",
          );
          this.log("overdue", { task_id: task.id });
        }
      }
      // One durable brief per Stockholm date, including startup catch-up after 06:00.
      if (
        this.now().hour >= 6 &&
        !this.db.prepare("SELECT 1 FROM daily_briefs WHERE day=?").get(today)
      ) {
        const summary = this.snapshot(today);
        this.db
          .prepare("INSERT INTO daily_briefs VALUES(?,?,?)")
          .run(
            today,
            this.calendar.sealIndex(`daily:${today}`, summary),
            this.time(),
          );
        this.log("daily_created", { day: today });
      }
    })();
    return true;
  }
  private agenda(day: string) {
    const start = DateTime.fromISO(day, { zone }).startOf("day"),
      end = start.plus({ days: 1 });
    const events = [];
    const allowed = new Set(
      this.calendar
        .accounts(true)
        .filter((a) => a.connected)
        .map((a) => a.id),
    );
    for (const r of this.db
      .prepare(
        "SELECT id,account_id,payload FROM sync_sources WHERE kind='calendar' AND status NOT IN('removed','excluded') AND occurred_at<? ORDER BY occurred_at",
      )
      .all(end.toUTC().toISO()!) as {
      id: string;
      account_id: string;
      payload: string;
    }[]) {
      if (!allowed.has(r.account_id)) continue;
      const doc = this.calendar.openIndex<SyncDocument>(
        `source:${r.id}`,
        r.payload,
      );
      if (doc.cancelled || !doc.starts_at) continue;
      if (
        Date.parse(doc.starts_at) >= end.toMillis() ||
        Date.parse(doc.ends_at ?? doc.starts_at) < start.toMillis() ||
        (doc.ends_at &&
          Date.parse(doc.ends_at) === start.toMillis() &&
          Date.parse(doc.starts_at) < start.toMillis())
      )
        continue;
      events.push({
        source_id: r.id,
        account_id: r.account_id,
        title: doc.title,
        starts_at: doc.starts_at,
        ends_at: doc.ends_at,
        preparation: calendarNeedsPreparation(doc, this.clock()),
      });
    }
    // Same event may appear in two calendar folders; retain distinct account/event instances.
    return events;
  }
  private snapshot(day: string) {
    const start = DateTime.fromISO(day, { zone }).startOf("day"),
      yesterday = start.minus({ days: 1 });
    const completed = this.db
      .prepare(
        "SELECT task_id,title,created_at FROM task_transitions WHERE to_done=1 AND from_done=0 AND created_at>=? AND created_at<? ORDER BY created_at DESC",
      )
      .all(yesterday.toUTC().toISO()!, start.toUTC().toISO()!) as {
      task_id: string;
      title: string;
      created_at: string;
    }[];
    const tracking = (
      this.db
        .prepare("SELECT value FROM workflow_meta WHERE key='tracking_from'")
        .get() as { value: string }
    ).value;
    const doneColumns = this.store.boards().flatMap((b) =>
      this.store
        .columns(b.id)
        .filter((c) => c.is_done && c.key !== "rejected")
        .map((c) => ({ board: b.name, name: c.name })),
    );
    // Existing activity records remain the source of truth before structured tracking began.
    for (const p of this.db
      .prepare(
        "SELECT p.task_id,p.created_at,p.content,t.title FROM posts p JOIN tasks t ON t.id=p.task_id WHERE p.kind='event' AND p.created_at>=? AND p.created_at<? AND p.created_at<?",
      )
      .all(yesterday.toUTC().toISO()!, start.toUTC().toISO()!, tracking) as {
      task_id: string;
      created_at: string;
      content: string;
      title: string;
    }[]) {
      const match = p.content.match(
        /^Flyttade från ”(.+)” \((.+)\) till ”(.+)” \((.+)\)\.$/u,
      );
      if (
        match &&
        doneColumns.some((c) => c.name === match[3] && c.board === match[4]) &&
        !doneColumns.some((c) => c.name === match[1] && c.board === match[2])
      )
        completed.push({
          task_id: p.task_id,
          title: p.title,
          created_at: p.created_at,
        });
    }
    const tasks = this.store.list(this.store.defaultBoardId()),
      active = tasks.filter((t) => !this.store.column(t.column_id).is_done);
    const due = active
      .filter((t) => t.due_date && t.due_date <= day)
      .map((t) => ({ id: t.id, title: t.title, due_date: t.due_date }));
    const waiting = active
      .filter((t) => this.store.column(t.column_id).key === "waiting")
      .map((t) => ({
        id: t.id,
        title: t.title,
        ...(this.db
          .prepare("SELECT reason,until_date FROM card_waiting WHERE task_id=?")
          .get(t.id) as { reason: string; until_date: string } | undefined),
      }));
    const urgent = (
      this.sync.taskScores(this.store.defaultBoardId()) as {
        task_id: string;
        urgency_score: number;
      }[]
    )
      .filter(
        (s) => s.urgency_score >= 75 && active.some((t) => t.id === s.task_id),
      )
      .map((s) => ({
        id: s.task_id,
        title: this.store.get(s.task_id).title,
        urgency: s.urgency_score,
      }));
    return {
      day,
      timezone: zone,
      agenda: this.agenda(day),
      yesterday: {
        day: yesterday.toISODate(),
        completed: [...new Map(completed.map((t) => [t.task_id, t])).values()],
        updated_cards: (
          this.db
            .prepare(
              "SELECT count(DISTINCT task_id) n FROM posts WHERE kind!='event' AND created_at>=? AND created_at<?",
            )
            .get(yesterday.toUTC().toISO()!, start.toUTC().toISO()!) as {
            n: number;
          }
        ).n,
      },
      due,
      waiting,
      urgent,
      notice:
        "Underlaget är synkade konton som tillåter AI-läsning. Agenda kan ändras; kontrollera synkstatus. Resultat avser registrerade flyttar till Klart, inte antaganden om utfört arbete.",
    };
  }
  daily(day = this.now().toISODate()!) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !DateTime.fromISO(day).isValid)
      throw new HttpError(400, "Ogiltigt datum.");
    const row = this.db
      .prepare("SELECT payload,created_at FROM daily_briefs WHERE day=?")
      .get(day) as { payload: string; created_at: string } | undefined;
    // Current agenda is live; never expose revoked account data from saved snapshots.
    const live = this.snapshot(day);
    const saved = row
      ? this.calendar.openIndex<ReturnType<Workflow["snapshot"]>>(
          `daily:${day}`,
          row.payload,
        )
      : null;
    const allowed = new Set(
      this.calendar
        .accounts(true)
        .filter((a) => a.connected)
        .map((a) => a.id),
    );
    return {
      main_board_id: this.store.defaultBoardId(),
      ...live,
      brief: saved
        ? {
            ...saved,
            agenda: saved.agenda.filter((e) => allowed.has(e.account_id)),
          }
        : null,
      created_at: row?.created_at ?? null,
      schedule: "06:00 Europe/Stockholm",
      next_at: this.now()
        .startOf("day")
        .plus({ days: this.now().hour >= 6 ? 1 : 0 })
        .set({ hour: 6 })
        .toISO(),
    };
  }
}
