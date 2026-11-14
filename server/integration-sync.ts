import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  analysisRequest,
  analysisSchema,
  indexSearch,
  syncSettings,
  type AnalysisRequest,
  type SourceAnalysis,
  type SyncDocument,
  type SyncFolder,
  type SyncSettings,
} from "../shared/sync.js";
import type { Assistant } from "./ai.js";
import { HttpError } from "./store.js";
import { Workflow } from "./workflow.js";
import { calendarNeedsPreparation } from "../shared/workflow.js";
import { scrub } from "./knowledge.js";

type Source = {
  id: string;
  account_id: string;
  kind: string;
  identity_hash: string;
  external_hash: string;
  thread_hash: string;
  stream_id: string | null;
  occurred_at: string;
  payload: string;
  content_hash: string;
  status: string;
  analysis: string | null;
  category: string | null;
  urgency: number | null;
  task_id: string | null;
  attempts: number;
  available_at: number;
  manual_priority: number;
  last_error: string | null;
};
type Stream = {
  id: string;
  account_id: string;
  kind: string;
  definition: string;
  checkpoint: string | null;
  next_at: number;
  attempts: number;
};
type Run = {
  id: string;
  status: string;
  request: string;
  checkpoint: string | null;
  created_at: string;
  finished_at: string | null;
  last_error: string | null;
};
type Plan = {
  account_id: string;
  folder: SyncFolder;
  cursor: string | null;
  count: number;
};
type RunCheckpoint = { accounts: string[]; plans: Plan[]; position: number };
const words = (s: string) => [
  ...new Set(
    s
      .toLocaleLowerCase("sv")
      .normalize("NFKC")
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  ),
];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const doneStates = new Set([
  "rejected",
  "done",
  "review",
  "excluded",
  "removed",
  "failed",
]);

/** Durable producer/consumer. The classifier receives data and a JSON schema,
 * never the general assistant's write tools. All Kanban writes are bounded here. */
export class IntegrationSync {
  readonly workflow: Workflow;
  private workflowTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private producing = false;
  private analyzing = false;
  private manualTurn = false;
  private analysisTurn = 0;
  private modelRetryAt = 0;
  private abort?: AbortController;
  constructor(
    readonly assistant: Assistant,
    private clock = () => Date.now(),
  ) {
    if (!assistant.calendar) throw new Error("Calendar service required");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_config(id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_discovery(account_id TEXT PRIMARY KEY REFERENCES calendar_accounts(id) ON DELETE CASCADE,next_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT);
      CREATE TABLE IF NOT EXISTS sync_streams(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,kind TEXT NOT NULL,definition TEXT NOT NULL,checkpoint TEXT,next_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,baseline_complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sync_sources(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,kind TEXT NOT NULL,identity_hash TEXT NOT NULL,external_hash TEXT NOT NULL,thread_hash TEXT NOT NULL,stream_id TEXT REFERENCES sync_streams(id) ON DELETE SET NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL,content_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',analysis TEXT,category TEXT,urgency INTEGER,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,manual_priority INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at TEXT NOT NULL,seen_round TEXT,UNIQUE(account_id,kind,identity_hash));
      CREATE INDEX IF NOT EXISTS sync_queue ON sync_sources(status,available_at,manual_priority,occurred_at);
      CREATE INDEX IF NOT EXISTS sync_external ON sync_sources(account_id,external_hash);
      CREATE INDEX IF NOT EXISTS sync_dates ON sync_sources(account_id,occurred_at DESC);
      CREATE TABLE IF NOT EXISTS sync_terms(source_id TEXT NOT NULL REFERENCES sync_sources(id) ON DELETE CASCADE,term TEXT NOT NULL,PRIMARY KEY(source_id,term));
      CREATE INDEX IF NOT EXISTS sync_term_lookup ON sync_terms(term,source_id);
      CREATE TABLE IF NOT EXISTS sync_links(group_hash TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,managed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_receipts(source_id TEXT NOT NULL REFERENCES sync_sources(id) ON DELETE CASCADE,content_hash TEXT NOT NULL,action TEXT NOT NULL,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,content_hash));
      CREATE TABLE IF NOT EXISTS sync_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,request_key TEXT NOT NULL,request TEXT NOT NULL,checkpoint TEXT,created_at TEXT NOT NULL,finished_at TEXT,last_error TEXT);
      CREATE TABLE IF NOT EXISTS sync_run_items(run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,source_id TEXT NOT NULL REFERENCES sync_sources(id) ON DELETE CASCADE,PRIMARY KEY(run_id,source_id));
    `);
    if (!this.db.prepare("SELECT 1 FROM sync_config WHERE id=1").get()) {
      const settings: SyncSettings = {
        enabled: false,
        board_id: assistant.store.defaultBoardId(),
        initial_days: 30,
        interval_seconds: 300,
        calendar_future_days: 90,
        account_ids: [],
        since: this.time(this.clock() - 30 * 86400000),
      };
      this.db
        .prepare("INSERT INTO sync_config VALUES(1,?)")
        .run(JSON.stringify(settings));
    }
    this.db
      .prepare("UPDATE sync_sources SET status='queued' WHERE status='running'")
      .run();
    this.workflow = new Workflow(this, clock);
  }
  private get db() {
    return this.assistant.store.db;
  }
  private get calendar() {
    return this.assistant.calendar!;
  }
  private time(ms = this.clock()) {
    return new Date(ms).toISOString();
  }
  settings(): SyncSettings {
    return JSON.parse(
      (
        this.db
          .prepare("SELECT settings FROM sync_config WHERE id=1")
          .get() as { settings: string }
      ).settings,
    );
  }
  configure(value: unknown) {
    const input = syncSettings.parse(value),
      previous = this.settings();
    if (input.enabled && !input.account_ids.length)
      throw new HttpError(400, "Välj minst ett konto för automatisk synk.");
    this.assistant.store.board(input.board_id);
    const allowed = new Set(
      this.calendar
        .accounts(true)
        .filter((x) => x.connected)
        .map((x) => x.id),
    );
    if (input.account_ids.some((id) => !allowed.has(id)))
      throw new HttpError(403, "Välj anslutna konton som tillåter AI-läsning.");
    const changed = input.initial_days !== previous.initial_days;
    const settings = {
      ...input,
      board_id: this.assistant.store.defaultBoardId(),
      since:
        changed || !previous.account_ids.length
          ? this.time(this.clock() - input.initial_days * 86400000)
          : previous.since,
    };
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE sync_config SET settings=? WHERE id=1")
        .run(JSON.stringify(settings));
      if (changed)
        this.db
          .prepare(
            "UPDATE sync_streams SET checkpoint=NULL,next_at=0,baseline_complete=0",
          )
          .run();
    })();
    if (!input.enabled) this.abort?.abort();
    this.audit("configured", {
      enabled: input.enabled,
      account_count: input.account_ids.length,
      initial_days: input.initial_days,
      board_id: input.board_id,
    });
    return this.status();
  }
  private audit(event: string, detail: Record<string, unknown>) {
    this.assistant.knowledge.log(`sync.${event}`, detail);
  }
  private allowed(id: string) {
    return this.calendar.accounts(true).some((x) => x.id === id && x.connected);
  }
  private auto(id: string) {
    const settings = this.settings();
    return (
      settings.enabled && settings.account_ids.includes(id) && this.allowed(id)
    );
  }
  private manual(id: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM sync_run_items i JOIN sync_runs r ON r.id=i.run_id WHERE i.source_id=? AND r.status='analyzing' LIMIT 1",
      )
      .get(id);
  }
  private canAnalyze(
    source: Pick<Source, "account_id" | "id" | "kind" | "occurred_at">,
  ) {
    if (!this.allowed(source.account_id)) return false;
    if (this.manual(source.id)) return true;
    const settings = this.settings();
    const ready =
      !!this.db
        .prepare("SELECT 1 FROM sync_streams WHERE account_id=? LIMIT 1")
        .get(source.account_id) &&
      !this.db
        .prepare(
          "SELECT 1 FROM sync_streams WHERE account_id=? AND kind='mail' AND baseline_complete=0 AND last_error IS NULL LIMIT 1",
        )
        .get(source.account_id);
    const inWindow =
      Date.parse(source.occurred_at) >=
      (source.kind === "mail"
        ? Date.parse(settings.since)
        : this.clock() - settings.initial_days * 86400000);
    return ready && inWindow && this.auto(source.account_id);
  }
  start() {
    this.workflow.initialize();
    this.workflow.tick(true);
    this.workflowTimer = setInterval(() => {
      if (this.closed) return;
      try {
        this.workflow.tick();
      } catch {
        this.audit("worker_error", { worker: "workflow" });
      }
    }, 1000);
    this.workflowTimer.unref();
    const loop = (work: () => Promise<boolean>, delay: number) => {
      const next = async () => {
        if (this.closed) return;
        let active = false;
        try {
          active = await work();
        } catch {
          if (!this.closed)
            this.audit("worker_error", {
              worker: delay === 1000 ? "producer" : "analysis",
            });
        }
        if (!this.closed) {
          const timer = setTimeout(next, active ? delay : 5000);
          timer.unref();
          this.timers.push(timer);
          if (this.timers.length > 10) this.timers.splice(0, 8);
        }
      };
      void next();
    };
    loop(() => this.produceOne(), 1000);
    loop(() => this.analyzeOne(), 250);
  }
  async close() {
    this.closed = true;
    clearInterval(this.workflowTimer);
    this.abort?.abort();
    this.timers.forEach(clearTimeout);
  }
  wake() {
    this.modelRetryAt = 0;
    this.db
      .prepare("UPDATE sync_streams SET next_at=0,attempts=0,last_error=NULL")
      .run();
    this.db
      .prepare("UPDATE sync_discovery SET next_at=0,attempts=0,last_error=NULL")
      .run();
    this.db
      .prepare(
        "UPDATE sync_sources SET status='queued',attempts=0,available_at=0,last_error=NULL WHERE status='failed'",
      )
      .run();
    this.db
      .prepare(
        "UPDATE sync_runs SET status=CASE WHEN status='partial' OR (checkpoint IS NULL AND EXISTS(SELECT 1 FROM sync_run_items i WHERE i.run_id=sync_runs.id)) THEN 'analyzing' ELSE 'indexing' END,finished_at=NULL,last_error=NULL WHERE status IN('partial','failed')",
      )
      .run();
    this.audit("retry_requested", {});
    return this.status();
  }
  status() {
    const counts = this.db
      .prepare(
        "SELECT status,count(*) AS count FROM sync_sources GROUP BY status",
      )
      .all() as { status: string; count: number }[];
    const scores = this.db
      .prepare(
        "SELECT category,count(*) AS count FROM sync_sources WHERE category IS NOT NULL GROUP BY category",
      )
      .all() as { category: string; count: number }[];
    const streams = this.db
      .prepare(
        "SELECT account_id,kind,count(*) AS folders,sum(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS errors FROM sync_streams GROUP BY account_id,kind",
      )
      .all() as {
      account_id: string;
      kind: string;
      folders: number;
      errors: number;
    }[];
    const errors = this.db
      .prepare(
        "SELECT account_id,last_error FROM sync_discovery WHERE last_error IS NOT NULL UNION ALL SELECT account_id,last_error FROM sync_streams WHERE last_error IS NOT NULL LIMIT 20",
      )
      .all() as { account_id: string; last_error: string }[];
    const actions = this.db
      .prepare(
        "SELECT action,count(*) AS count FROM sync_receipts GROUP BY action",
      )
      .all() as { action: string; count: number }[];
    return {
      settings: this.settings(),
      counts,
      categories: scores,
      streams,
      errors,
      actions,
      producing: this.producing,
      analyzing: this.analyzing,
      runs: (
        this.db
          .prepare("SELECT id FROM sync_runs ORDER BY created_at DESC LIMIT 10")
          .all() as { id: string }[]
      ).map((x) => this.run(x.id)),
    };
  }
  summary() {
    const counts = this.db
      .prepare(
        "SELECT sum(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM sync_sources",
      )
      .get() as { queued: number | null; failed: number | null };
    return {
      enabled: this.settings().enabled,
      queued: counts.queued ?? 0,
      failed: counts.failed ?? 0,
      analyzing: this.analyzing,
    };
  }
  private streamPayload(stream: Stream) {
    return this.calendar.openIndex<{
      phase?: "prime" | "delta";
      round?: string;
      cursor: string | null;
      start: string;
      end: string;
    }>(`stream:${stream.id}`, stream.checkpoint!);
  }
  async produceOne(): Promise<boolean> {
    if (this.closed || this.producing) return false;
    this.producing = true;
    try {
      const manual = this.db
        .prepare(
          "SELECT * FROM sync_runs WHERE status='indexing' ORDER BY created_at LIMIT 1",
        )
        .get() as Run | undefined;
      const settings = this.settings();
      this.manualTurn = !this.manualTurn;
      if (manual && (!settings.enabled || this.manualTurn))
        return await this.discoverRun(manual);
      if (!settings.enabled) return false;
      const ids = settings.account_ids.filter((id) => this.allowed(id));
      for (const id of ids)
        this.db
          .prepare("INSERT OR IGNORE INTO sync_discovery(account_id) VALUES(?)")
          .run(id);
      const discoveries = this.db
        .prepare(
          "SELECT account_id,next_at,attempts FROM sync_discovery WHERE next_at<=? ORDER BY next_at",
        )
        .all(this.clock()) as {
        account_id: string;
        next_at: number;
        attempts: number;
      }[];
      const discovery = discoveries.find((x) => ids.includes(x.account_id));
      if (discovery) {
        try {
          const folders = await this.calendar.syncFolders(discovery.account_id);
          if (this.closed || !this.auto(discovery.account_id)) return false;
          this.db.transaction(() => {
            const active = new Set<string>();
            for (const folder of folders) {
              const id = this.calendar.indexHash(
                `${discovery.account_id}/${folder.kind}/${folder.id}`,
              );
              active.add(id);
              this.db
                .prepare(
                  "INSERT INTO sync_streams(id,account_id,kind,definition) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition",
                )
                .run(
                  id,
                  discovery.account_id,
                  folder.kind,
                  this.calendar.sealIndex(`folder:${id}`, folder),
                );
              if (folder.kind === "mail") {
                const pollId = this.calendar.indexHash(
                  `${discovery.account_id}/mail-poll/${folder.id}`,
                );
                active.add(pollId);
                const checkpoint = this.calendar.sealIndex(`stream:${pollId}`, {
                  cursor: null,
                  start: this.time(this.clock() - 300000),
                  end: this.time(),
                });
                this.db
                  .prepare(
                    "INSERT INTO sync_streams(id,account_id,kind,definition,checkpoint,next_at) VALUES(?,?,'mail_poll',?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition",
                  )
                  .run(
                    pollId,
                    discovery.account_id,
                    this.calendar.sealIndex(`folder:${pollId}`, folder),
                    checkpoint,
                    this.clock() + settings.interval_seconds * 1000,
                  );
              }
            }
            for (const row of this.db
              .prepare("SELECT id FROM sync_streams WHERE account_id=?")
              .all(discovery.account_id) as { id: string }[])
              if (!active.has(row.id))
                this.db
                  .prepare("DELETE FROM sync_streams WHERE id=?")
                  .run(row.id);
            this.db
              .prepare(
                "UPDATE sync_discovery SET next_at=?,attempts=0,last_error=NULL WHERE account_id=?",
              )
              .run(this.clock() + 3600000, discovery.account_id);
          })();
          this.audit("folders_discovered", {
            account_id: discovery.account_id,
            folder_count: folders.length,
          });
        } catch {
          if (!this.closed)
            this.db
              .prepare(
                "UPDATE sync_discovery SET next_at=?,attempts=attempts+1,last_error='Kunde inte läsa mappar. Kontrollera konto/VPN och prova Synka nu.' WHERE account_id=?",
              )
              .run(
                this.clock() + this.backoff(discovery.attempts),
                discovery.account_id,
              );
        }
        return true;
      }
      const stream = (
        this.db
          .prepare(
            "SELECT * FROM sync_streams WHERE next_at<=? ORDER BY next_at,id",
          )
          .all(this.clock()) as Stream[]
      ).find((x) => ids.includes(x.account_id));
      if (!stream) return manual ? this.discoverRun(manual) : false;
      try {
        const folder = this.calendar.openIndex<SyncFolder>(
          `folder:${stream.id}`,
          stream.definition,
        );
        const polling = stream.kind === "mail_poll";
        const saved = stream.checkpoint
          ? this.streamPayload(stream)
          : {
              phase: "prime" as const,
              round: randomUUID(),
              cursor: null,
              start:
                folder.kind === "mail"
                  ? settings.since
                  : this.time(this.clock() - settings.initial_days * 86400000),
              end: this.time(
                this.clock() +
                  (folder.kind === "mail"
                    ? 0
                    : settings.calendar_future_days * 86400000),
              ),
            };
        if (polling && !saved.cursor) saved.end = this.time();
        const priming =
          folder.kind === "mail" && saved.phase === "prime" && !polling;
        const page = await this.calendar.syncPage(
          stream.account_id,
          folder,
          saved.cursor,
          saved.start,
          saved.end,
          priming || polling,
        );
        if (this.closed || !this.auto(stream.account_id)) return false;
        this.db.transaction(() => {
          for (const document of page.documents) {
            if (
              document.kind === "mail" &&
              Date.parse(document.occurred_at) < Date.parse(settings.since)
            )
              continue;
            const sourceStream = polling
              ? this.calendar.indexHash(
                  `${stream.account_id}/${folder.kind}/${folder.id}`,
                )
              : stream.id;
            const id = this.ingest(stream.account_id, document, sourceStream);
            if (folder.kind === "calendar")
              this.db
                .prepare("UPDATE sync_sources SET seen_round=? WHERE id=?")
                .run(saved.round!, id);
          }
          for (const removed of page.removed)
            this.db
              .prepare(
                "UPDATE sync_sources SET status='removed',last_error=NULL WHERE account_id=? AND external_hash=? AND stream_id=?",
              )
              .run(
                stream.account_id,
                this.calendar.indexHash(`external:${removed}`),
                stream.id,
              );
          if (folder.kind === "calendar" && page.complete)
            this.db
              .prepare(
                "UPDATE sync_sources SET status='removed' WHERE stream_id=? AND occurred_at>=? AND occurred_at<? AND (seen_round IS NULL OR seen_round!=?)",
              )
              .run(stream.id, saved.start, saved.end, saved.round!);
          const state =
            polling && page.complete
              ? {
                  cursor: null,
                  start: this.time(Date.parse(saved.end) - 300000),
                  end: saved.end,
                }
              : {
                  ...saved,
                  phase: priming && page.complete ? "delta" : saved.phase,
                  cursor: priming && page.complete ? null : page.cursor,
                };
          const checkpoint =
            page.complete && folder.kind === "calendar"
              ? null
              : this.calendar.sealIndex(`stream:${stream.id}`, state);
          this.db
            .prepare(
              "UPDATE sync_streams SET checkpoint=?,next_at=?,attempts=0,last_error=NULL,baseline_complete=CASE WHEN ? THEN 1 ELSE baseline_complete END WHERE id=?",
            )
            .run(
              checkpoint,
              this.clock() +
                (page.complete && !priming
                  ? settings.interval_seconds * 1000
                  : 1),
              page.complete ? 1 : 0,
              stream.id,
            );
        })();
        this.audit("page_indexed", {
          account_id: stream.account_id,
          kind: folder.kind,
          received: page.documents.length,
          removed: page.removed.length,
          complete: page.complete,
        });
      } catch {
        if (!this.closed)
          this.db
            .prepare(
              "UPDATE sync_streams SET next_at=?,attempts=attempts+1,last_error='Synkfel. Kontrollera konto/VPN och prova Synka nu.' WHERE id=?",
            )
            .run(this.clock() + this.backoff(stream.attempts), stream.id);
      }
      return true;
    } finally {
      this.producing = false;
    }
  }
  private backoff(attempts: number) {
    return Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7));
  }
  ingest(
    accountId: string,
    document: SyncDocument,
    streamId: string | null = null,
    queue = true,
  ) {
    if (!this.allowed(accountId))
      throw new HttpError(403, "Kontot tillåter inte AI-läsning.");
    if (
      !document.external_id ||
      !document.identity ||
      !Number.isFinite(Date.parse(document.occurred_at))
    )
      throw new HttpError(502, "Källan saknar giltigt ID eller datum.");
    const identity = this.calendar.indexHash(
      `${document.kind}/identity/${document.identity}`,
    );
    const external = this.calendar.indexHash(
      `external:${document.external_id}`,
    );
    const thread = this.calendar.indexHash(
      `${accountId}/${document.kind}/thread/${document.thread_id || document.identity}`,
    );
    const {
      external_id: _external,
      folder: _folder,
      url: _url,
      owner: _owner,
      ...content
    } = document;
    const fingerprint = hash(JSON.stringify(content));
    const old = this.db
      .prepare(
        "SELECT * FROM sync_sources WHERE account_id=? AND kind=? AND identity_hash=?",
      )
      .get(accountId, document.kind, identity) as Source | undefined;
    const id = old?.id || randomUUID();
    const payload = this.calendar.sealIndex(
      `source:${id}`,
      this.workflow.isIgnored(document)
        ? { ...document, body: "", body_truncated: true }
        : document,
    );
    this.db.transaction(() => {
      if (old && old.content_hash === fingerprint) {
        this.db
          .prepare(
            "UPDATE sync_sources SET payload=?,external_hash=?,stream_id=COALESCE(?,stream_id),status=CASE WHEN status='removed' THEN ? WHEN status='indexed' AND ? THEN 'queued' ELSE status END WHERE id=?",
          )
          .run(
            payload,
            external,
            streamId,
            queue ? "queued" : "indexed",
            queue ? 1 : 0,
            id,
          );
        return;
      }
      this.db
        .prepare(
          "INSERT INTO sync_sources(id,account_id,kind,identity_hash,external_hash,thread_hash,stream_id,occurred_at,payload,content_hash,updated_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,external_hash=excluded.external_hash,thread_hash=excluded.thread_hash,stream_id=COALESCE(excluded.stream_id,sync_sources.stream_id),occurred_at=excluded.occurred_at,content_hash=excluded.content_hash,status=CASE WHEN sync_sources.status IN('queued','running') THEN 'queued' ELSE excluded.status END,analysis=NULL,category=NULL,urgency=NULL,attempts=0,available_at=0,last_error=NULL,updated_at=excluded.updated_at",
        )
        .run(
          id,
          accountId,
          document.kind,
          identity,
          external,
          thread,
          streamId,
          this.time(Date.parse(document.occurred_at)),
          payload,
          fingerprint,
          this.time(),
          queue ? "queued" : "indexed",
        );
      this.db.prepare("DELETE FROM sync_terms WHERE source_id=?").run(id);
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO sync_terms VALUES(?,?)",
      );
      for (const word of words(
        `${document.title} ${document.body} ${document.sender} ${document.recipients.join(" ")}`,
      ))
        insert.run(id, this.calendar.indexHash(`term:${word}`));
      if (
        document.kind === "mail" &&
        ["incoming", "sent"].includes(document.role)
      )
        this.db
          .prepare(
            "UPDATE sync_sources SET status='queued',available_at=0 WHERE account_id=? AND thread_hash=? AND id!=? AND status IN('done','review')",
          )
          .run(accountId, thread, id);
    })();
    if (this.workflow.isIgnored(document)) this.workflow.exclude(id, document);
    return id;
  }
  private source(id: string): Source {
    const row = this.db
      .prepare("SELECT * FROM sync_sources WHERE id=?")
      .get(id) as Source | undefined;
    if (!row || !this.allowed(row.account_id))
      throw new HttpError(404, "Indexkällan är inte tillgänglig.");
    return row;
  }
  item(id: string, ai = false) {
    if (ai && this.source(id).status === "excluded")
      throw new HttpError(
        403,
        "Avsändaren är ignorerad. Källan lämnas inte till AI:n.",
      );
    const row = this.source(id),
      document = this.calendar.openIndex<SyncDocument>(
        `source:${id}`,
        row.payload,
      );
    const analysis = row.analysis
      ? this.calendar.openIndex<SourceAnalysis>(`analysis:${id}`, row.analysis)
      : null;
    return {
      id,
      account_id: row.account_id,
      document: {
        ...document,
        body: document.body.slice(0, ai ? 12000 : 30000),
        body_truncated:
          document.body_truncated || (ai && document.body.length > 12000),
      },
      status: row.status,
      analysis,
      task_id: row.task_id,
      last_error: row.last_error,
    };
  }
  search(value: unknown) {
    const input = indexSearch.parse(value),
      allowed = new Set(
        this.calendar
          .accounts(true)
          .filter((a) => a.connected)
          .map((a) => a.id),
      );
    const terms = words(input.query)
      .slice(0, 12)
      .map((w) => this.calendar.indexHash(`term:${w}`));
    if (!allowed.size) return { items: [], total: 0, next_offset: null };
    const condition = `FROM sync_sources s WHERE status!='excluded' AND account_id IN(${[...allowed].map(() => "?").join(",")}) AND (?='all' OR kind=?) AND (? IS NULL OR account_id=?) AND (? IS NULL OR category=?) AND COALESCE(urgency,0)>=? AND (? IS NULL OR occurred_at>=?) AND (? IS NULL OR occurred_at<?) ${terms.length ? `AND id IN(SELECT source_id FROM sync_terms WHERE term IN (${terms.map(() => "?").join(",")}) GROUP BY source_id HAVING count(*)=?)` : ""}`;
    const parameters = [
      ...allowed,
      input.kind,
      input.kind,
      input.account_id ?? null,
      input.account_id ?? null,
      input.category ?? null,
      input.category ?? null,
      input.min_urgency,
      input.from ?? null,
      input.from ?? null,
      input.to ?? null,
      input.to ?? null,
      ...terms,
      ...(terms.length ? [terms.length] : []),
    ];
    const total = (
      this.db
        .prepare(`SELECT count(*) AS count ${condition}`)
        .get(...parameters) as { count: number }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT s.* ${condition} ORDER BY occurred_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(...parameters, input.limit, input.offset) as Source[];
    return {
      items: rows.map((row) => {
        const item = this.item(row.id);
        const { body: _body, ...document } = item.document;
        return { ...item, document };
      }),
      total,
      next_offset:
        input.offset + input.limit < total ? input.offset + input.limit : null,
    };
  }
  request(value: unknown) {
    const input = analysisRequest.parse(value);
    const accounts =
      input.account_ids ??
      this.calendar
        .accounts(true)
        .filter((a) => a.connected)
        .map((a) => a.id);
    if (!accounts.length || accounts.some((id) => !this.allowed(id)))
      throw new HttpError(403, "Välj anslutna konton med AI-läsning.");
    const requestKey = this.calendar.indexHash(
      JSON.stringify({ ...input, account_ids: [...accounts].sort() }),
    );
    const existing = this.db
      .prepare(
        "SELECT id FROM sync_runs WHERE request_key=? AND status IN('indexing','analyzing') LIMIT 1",
      )
      .get(requestKey) as { id: string } | undefined;
    if (existing) return this.run(existing.id);
    if (
      (
        this.db
          .prepare(
            "SELECT count(*) AS count FROM sync_runs WHERE status IN('indexing','analyzing')",
          )
          .get() as { count: number }
      ).count >= 10
    )
      throw new HttpError(
        429,
        "Högst tio analyskörningar kan vänta samtidigt.",
      );
    const id = randomUUID(),
      request = {
        ...input,
        account_ids: accounts,
        to: input.to || this.time(),
        from: input.from || "1900-01-01T00:00:00.000Z",
      };
    this.db
      .prepare(
        "INSERT INTO sync_runs(id,status,request_key,request,created_at) VALUES(?,'indexing',?,?,?)",
      )
      .run(
        id,
        requestKey,
        this.calendar.sealIndex(`run:${id}`, request),
        this.time(),
      );
    this.audit("analysis_requested", {
      run_id: id,
      kind: input.kind,
      account_count: accounts.length,
      limit: input.limit ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
    });
    return this.run(id);
  }
  run(id: string) {
    const row = this.db
      .prepare("SELECT * FROM sync_runs WHERE id=?")
      .get(id) as Run | undefined;
    if (!row) throw new HttpError(404, "Analyskörningen saknas.");
    const request = this.calendar.openIndex<AnalysisRequest>(
      `run:${id}`,
      row.request,
    );
    const counts = this.db
      .prepare(
        "SELECT s.status,count(*) AS count FROM sync_sources s JOIN sync_run_items i ON i.source_id=s.id WHERE i.run_id=? GROUP BY s.status",
      )
      .all(id) as { status: string; count: number }[];
    const actions = this.db
      .prepare(
        "SELECT r.action,count(*) AS count FROM sync_receipts r JOIN sync_run_items i ON i.source_id=r.source_id WHERE i.run_id=? AND r.created_at>=? GROUP BY r.action",
      )
      .all(id, row.created_at);
    return {
      id,
      status: row.status,
      request,
      counts,
      actions,
      created_at: row.created_at,
      finished_at: row.finished_at,
      last_error: row.last_error,
    };
  }
  cancel(id: string) {
    this.run(id);
    this.db
      .prepare(
        "UPDATE sync_runs SET status='cancelled',finished_at=? WHERE id=? AND status IN('indexing','analyzing')",
      )
      .run(this.time(), id);
    this.audit("run_cancelled", { run_id: id });
    return this.run(id);
  }
  private async discoverRun(row: Run): Promise<boolean> {
    const request = this.calendar.openIndex<AnalysisRequest>(
      `run:${row.id}`,
      row.request,
    );
    const checkpoint: RunCheckpoint = row.checkpoint
      ? this.calendar.openIndex(`run-checkpoint:${row.id}`, row.checkpoint)
      : { accounts: [...request.account_ids!], plans: [], position: 0 };
    try {
      if (checkpoint.accounts.length) {
        const account = checkpoint.accounts.shift()!;
        if (!this.allowed(account))
          throw new HttpError(403, "Kontots AI-läsning har återkallats.");
        const folders = await this.calendar.syncFolders(account);
        checkpoint.plans.push(
          ...folders
            .filter(
              (f) =>
                (request.kind === "all" || request.kind === f.kind) &&
                !["drafts", "deleted"].includes(f.role),
            )
            .map((folder) => ({
              account_id: account,
              folder,
              cursor: null,
              count: 0,
            })),
        );
      } else if (checkpoint.position < checkpoint.plans.length) {
        const plan = checkpoint.plans[checkpoint.position];
        if (!this.allowed(plan.account_id))
          throw new HttpError(403, "Kontots AI-läsning har återkallats.");
        const page = await this.calendar.syncPage(
          plan.account_id,
          plan.folder,
          plan.cursor,
          request.from!,
          request.to!,
          true,
        );
        if (
          this.closed ||
          (
            this.db
              .prepare("SELECT status FROM sync_runs WHERE id=?")
              .get(row.id) as Run
          ).status !== "indexing"
        )
          return false;
        this.db.transaction(() => {
          for (const document of page.documents) {
            if (
              Date.parse(document.occurred_at) < Date.parse(request.from!) ||
              Date.parse(document.occurred_at) >= Date.parse(request.to!)
            )
              continue;
            const id = this.ingest(plan.account_id, document, null, false);
            if (plan.folder.role !== "sent")
              this.db
                .prepare("INSERT OR IGNORE INTO sync_run_items VALUES(?,?)")
                .run(row.id, id);
          }
        })();
        plan.count += page.documents.length;
        plan.cursor = page.cursor;
        // Mail pages are newest-first. N per folder is sufficient to choose the
        // global newest N after discovery; no per-folder interpretation of N.
        if (
          page.complete ||
          (plan.folder.kind === "mail" &&
            request.limit &&
            plan.count >= request.limit)
        )
          checkpoint.position++;
      } else {
        this.db.transaction(() => {
          if (request.limit)
            this.db
              .prepare(
                "DELETE FROM sync_run_items WHERE run_id=? AND source_id NOT IN(SELECT s.id FROM sync_sources s JOIN sync_run_items i ON i.source_id=s.id WHERE i.run_id=? ORDER BY s.occurred_at DESC,s.id LIMIT ?)",
              )
              .run(row.id, row.id, request.limit);
          this.db
            .prepare(
              "UPDATE sync_sources SET status='queued',manual_priority=100,available_at=0,attempts=0,last_error=NULL WHERE id IN(SELECT source_id FROM sync_run_items WHERE run_id=?)",
            )
            .run(row.id);
          this.db
            .prepare(
              "UPDATE sync_runs SET status='analyzing',checkpoint=NULL WHERE id=?",
            )
            .run(row.id);
        })();
        this.finishRuns();
        return true;
      }
      if (!this.closed)
        this.db
          .prepare(
            "UPDATE sync_runs SET checkpoint=? WHERE id=? AND status='indexing'",
          )
          .run(
            this.calendar.sealIndex(`run-checkpoint:${row.id}`, checkpoint),
            row.id,
          );
    } catch {
      if (!this.closed)
        this.db
          .prepare(
            "UPDATE sync_runs SET status='failed',last_error='Kunde inte läsa hela urvalet. Kontrollera konto/VPN och starta en ny analys.',finished_at=? WHERE id=?",
          )
          .run(this.time(), row.id);
    }
    return true;
  }
  private candidates(document: SyncDocument, row: Source) {
    const terms = new Set(
      words(`${document.title} ${document.body.slice(0, 800)}`),
    );
    const linked = this.db
      .prepare(
        "SELECT task_id FROM sync_links WHERE group_hash IN(?,?) AND task_id IS NOT NULL",
      )
      .all(row.thread_hash, row.identity_hash) as { task_id: string }[];
    const ids = new Set(linked.map((x) => x.task_id));
    const tasks = this.db
      .prepare(
        "SELECT t.id,t.title,t.description,t.priority,t.due_date,c.is_done,b.name AS board_name FROM tasks t JOIN columns c ON c.id=t.column_id JOIN boards b ON b.id=c.board_id",
      )
      .all() as {
      id: string;
      title: string;
      description: string;
      priority: string;
      due_date: string | null;
      is_done: number;
      board_name: string;
    }[];
    const candidates = tasks
      .map((task) => ({
        ...task,
        rank:
          words(task.title + " " + task.description).filter((w) => terms.has(w))
            .length + (ids.has(task.id) ? 10000 : 0),
      }))
      .filter((t) => t.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 8)
      .map((task) => ({
        ...task,
        description: task.description.slice(0, 600),
        latest_posts: this.assistant.store
          .detail(task.id, undefined, 2)
          .posts.map((p) => p.content.slice(0, 200)),
      }));
    while (candidates.length > 1 && JSON.stringify(candidates).length > 8000)
      candidates.pop();
    return candidates;
  }
  async analyzeOne(): Promise<boolean> {
    if (this.closed || this.analyzing || this.clock() < this.modelRetryAt)
      return false;
    this.finishRuns();
    const rows = this.db
      .prepare(
        "SELECT id,account_id,kind,occurred_at FROM sync_sources WHERE status='queued' AND available_at<=? ORDER BY manual_priority DESC,CASE WHEN kind='mail' AND occurred_at>=? THEN 0 WHEN kind='calendar' AND occurred_at>=? AND occurred_at<=? THEN 1 WHEN kind='mail' THEN 2 ELSE 3 END,CASE WHEN kind='calendar' AND occurred_at>=? THEN occurred_at ELSE '9999' END,occurred_at DESC,id",
      )
      .all(
        this.clock(),
        this.time(this.clock() - 86400000),
        this.time(),
        this.time(this.clock() + 7 * 86400000),
        this.time(),
      ) as Pick<Source, "id" | "account_id" | "kind" | "occurred_at">[];
    const allowed = new Set(
      this.calendar
        .accounts(true)
        .filter((a) => a.connected)
        .map((a) => a.id),
    );
    const ready = new Set(
      (
        this.db
          .prepare(
            "SELECT account_id FROM sync_streams GROUP BY account_id HAVING sum(CASE WHEN kind='mail' AND baseline_complete=0 AND last_error IS NULL THEN 1 ELSE 0 END)=0",
          )
          .all() as { account_id: string }[]
      ).map((x) => x.account_id),
    );
    const manual = new Set(
      (
        this.db
          .prepare(
            "SELECT DISTINCT source_id FROM sync_run_items i JOIN sync_runs r ON r.id=i.run_id WHERE r.status='analyzing'",
          )
          .all() as { source_id: string }[]
      ).map((x) => x.source_id),
    );
    const settings = this.settings();
    const eligible = rows.filter(
      (s) =>
        allowed.has(s.account_id) &&
        (manual.has(s.id) ||
          (settings.enabled &&
            settings.account_ids.includes(s.account_id) &&
            ready.has(s.account_id) &&
            Date.parse(s.occurred_at) >=
              (s.kind === "mail"
                ? Date.parse(settings.since)
                : this.clock() - settings.initial_days * 86400000))),
    );
    const selected =
      (++this.analysisTurn % 5 === 0
        ? eligible.find((s) => !manual.has(s.id))
        : undefined) ?? eligible[0];
    if (!selected) return false;
    const row = this.source(selected.id);
    this.analyzing = true;
    this.abort = new AbortController();
    this.db
      .prepare("UPDATE sync_sources SET status='running' WHERE id=?")
      .run(row.id);
    let stage = "classification";
    try {
      const document = this.calendar.openIndex<SyncDocument>(
        `source:${row.id}`,
        row.payload,
      );
      if (this.workflow.isIgnored(document)) {
        this.workflow.exclude(row.id, document);
        return true;
      }
      if (
        this.workflow.isRejected(row.thread_hash, row.identity_hash) ||
        (row.task_id && this.workflow.rejectedTask(row.task_id))
      ) {
        this.db
          .prepare(
            "UPDATE sync_sources SET status='rejected',urgency=0,manual_priority=0,last_error=NULL WHERE id=?",
          )
          .run(row.id);
        return true;
      }
      const candidates = this.candidates(document, row);
      let analysis: SourceAnalysis;
      if (
        ["junk", "drafts", "deleted"].includes(document.role) ||
        document.cancelled ||
        (document.kind === "calendar" &&
          !calendarNeedsPreparation(document, this.clock()))
      )
        analysis = {
          category: document.role === "junk" ? "spam" : "information",
          urgency: 0,
          action_required: false,
          confidence: 1,
          summary: document.cancelled
            ? "Kalenderhändelsen är avbokad."
            : document.role === "junk"
              ? "Servern har placerat mejlet i skräppost."
              : "Inget konkret förberedelsebehov eller nytt inkommande åtagande.",
          action_title: "",
          action_details: "",
          due_date: null,
          evidence: "",
          match_task_id: null,
          match_confidence: 0,
        };
      else {
        const related = (
          this.db
            .prepare(
              "SELECT id FROM sync_sources WHERE account_id=? AND thread_hash=? AND id!=? AND status NOT IN('excluded','rejected') ORDER BY occurred_at DESC LIMIT 8",
            )
            .all(row.account_id, row.thread_hash, row.id) as { id: string }[]
        ).map((x) => {
          const item = this.item(x.id, true);
          return { ...item.document, body: item.document.body.slice(0, 2500) };
        });
        analysis = analysisSchema.parse(
          await this.assistant.analyzeSource(
            document,
            candidates,
            this.abort.signal,
            related,
            !!this.db
              .prepare(
                "SELECT 1 FROM sync_streams WHERE account_id=? AND kind='mail' AND (last_error IS NOT NULL OR baseline_complete=0) LIMIT 1",
              )
              .get(row.account_id),
            this.workflow.feedback(document, row.account_id),
          ),
        );
      }
      if (this.closed) return false;
      this.modelRetryAt = 0;
      const current = this.source(row.id);
      if (
        current.content_hash !== row.content_hash ||
        current.status !== "running"
      )
        return true;
      if (!this.canAnalyze(current)) {
        this.db
          .prepare("UPDATE sync_sources SET status='queued' WHERE id=?")
          .run(row.id);
        return false;
      }
      stage = "commit";
      this.apply(row, document, analysis, new Set(candidates.map((t) => t.id)));
    } catch (error) {
      if (this.abort?.signal.aborted && !this.closed) {
        this.db
          .prepare(
            "UPDATE sync_sources SET status='queued' WHERE id=? AND content_hash=? AND status='running'",
          )
          .run(row.id, row.content_hash);
        return false;
      }
      if (stage === "classification")
        this.modelRetryAt = this.clock() + this.backoff(row.attempts);
      if (!this.closed && this.db.open)
        this.db
          .prepare(
            "UPDATE sync_sources SET status=?,attempts=attempts+1,available_at=?,last_error=? WHERE id=? AND content_hash=? AND status='running'",
          )
          .run(
            row.attempts >= 2 ? "failed" : "queued",
            this.clock() + this.backoff(row.attempts),
            "Analysen kunde inte slutföras. Försöker igen; efter tre fel visas posten som misslyckad.",
            row.id,
            row.content_hash,
          );
      if (!this.closed)
        this.audit("analysis_failed", {
          source_id: row.id,
          account_id: row.account_id,
          attempt: row.attempts + 1,
          stage,
          code:
            error instanceof z.ZodError
              ? "invalid_model_schema"
              : error instanceof SyntaxError
                ? "invalid_model_json"
                : "analysis_failed",
        });
    } finally {
      this.analyzing = false;
      this.abort = undefined;
      if (!this.closed) this.finishRuns();
    }
    return true;
  }
  private apply(
    row: Source,
    document: SyncDocument,
    result: SourceAnalysis,
    candidateIds: Set<string>,
  ) {
    const analysis = analysisSchema.parse(scrub(result));
    if (
      document.role === "sent" ||
      (document.kind === "calendar" &&
        !calendarNeedsPreparation(document, this.clock()))
    ) {
      analysis.category = "information";
      analysis.action_required = false;
    }
    if (
      ["spam", "newsletter", "information"].includes(analysis.category) ||
      !analysis.action_required
    ) {
      analysis.urgency = 0;
      analysis.action_required = false;
    }
    if (this.workflow.isIgnored(document)) {
      this.workflow.exclude(row.id, document);
      return;
    }
    if (
      this.workflow.isRejected(row.thread_hash, row.identity_hash) ||
      (row.task_id && this.workflow.rejectedTask(row.task_id))
    ) {
      this.db
        .prepare(
          "UPDATE sync_sources SET status='rejected',urgency=0,manual_priority=0,last_error=NULL WHERE id=?",
        )
        .run(row.id);
      return;
    }
    const evidence = analysis.evidence.trim();
    if (
      document.kind === "calendar" &&
      !calendarNeedsPreparation(
        { ...document, title: "", body: evidence },
        this.clock(),
      )
    ) {
      analysis.action_required = false;
      analysis.urgency = 0;
    }
    const actionable =
      analysis.action_required &&
      analysis.confidence >= 0.85 &&
      evidence.length >= 8 &&
      `${document.title}\n${document.body}`.includes(evidence) &&
      !!analysis.action_title.trim();
    const needsReview = analysis.action_required && !actionable;
    this.db.transaction(() => {
      // Commit the card/feed/receipt together. A crash can replay classification,
      // but never duplicate a committed action for the same source version.
      const receipt = this.db
        .prepare(
          "SELECT * FROM sync_receipts WHERE source_id=? AND content_hash=?",
        )
        .get(row.id, row.content_hash) as
        | { action: string; task_id: string | null }
        | undefined;
      const prior =
        receipt && ["created", "updated"].includes(receipt.action)
          ? receipt
          : undefined;
      let action = prior?.action ?? (needsReview ? "review" : "ignored"),
        taskId = prior?.task_id ?? row.task_id;
      if (!prior && actionable) {
        const links = this.db
          .prepare("SELECT * FROM sync_links WHERE group_hash IN(?,?)")
          .all(row.thread_hash, row.identity_hash) as {
          group_hash: string;
          task_id: string | null;
          managed: string;
        }[];
        const linkedIds = new Set(links.map((x) => x.task_id).filter(Boolean));
        const candidateMatch =
          analysis.match_task_id &&
          analysis.match_confidence >= 0.92 &&
          candidateIds.has(analysis.match_task_id)
            ? analysis.match_task_id
            : null;
        if (
          (candidateMatch && this.workflow.rejectedTask(candidateMatch)) ||
          links.some((l) => !l.task_id) ||
          linkedIds.size > 1 ||
          (analysis.match_task_id && !candidateMatch && !linkedIds.size)
        )
          action = "review";
        else {
          taskId = [...linkedIds][0] ?? candidateMatch;
          const priority =
            analysis.urgency >= 75
              ? "high"
              : analysis.urgency >= 35
                ? "normal"
                : "low";
          let managed: { priority?: string; due_date?: string | null } = {};
          if (!taskId) {
            const task = this.assistant.store.create(
              {
                board_id: this.assistant.store.defaultBoardId(),
                column_id: this.workflow.inbox().id,
                title: analysis.action_title.trim(),
                description: analysis.action_details || analysis.summary,
                priority,
                due_date: analysis.due_date,
              },
              "assistant",
            );
            taskId = task.id;
            managed = { priority, due_date: analysis.due_date };
            action = "created";
          } else {
            const task = this.assistant.store.get(taskId);
            const previous = links.find((l) => l.task_id === taskId);
            managed = previous ? JSON.parse(previous.managed) : {};
            const updates: {
              priority?: "low" | "normal" | "high";
              due_date?: string;
            } = {};
            if (managed.priority && task.priority === managed.priority)
              updates.priority = priority;
            if (
              analysis.due_date &&
              Object.hasOwn(managed, "due_date") &&
              task.due_date === managed.due_date
            )
              updates.due_date = analysis.due_date;
            if (Object.keys(updates).length) {
              this.assistant.store.update(taskId, updates, "assistant");
              managed = { ...managed, ...updates };
            }
            action = "updated";
          }
          const source = `${document.kind === "mail" ? "Mejl" : "Kalender"}: ${document.title}\nDatum: ${document.occurred_at}\nAvsändare/organisatör: ${document.sender}\nIndexreferens: ${row.id}`;
          this.assistant.store.addPost(
            taskId!,
            {
              kind: "update",
              content:
                `AI · ${analysis.urgency}% · ${analysis.category}\n\n${analysis.summary}\n\nNästa steg:\n${analysis.action_details || analysis.action_title}\n\nUnderlag:\n${evidence}\n\n${source}`.slice(
                  0,
                  10000,
                ),
            },
            "assistant",
          );
          for (const group of [row.thread_hash, row.identity_hash])
            this.db
              .prepare(
                "INSERT INTO sync_links VALUES(?,?,?) ON CONFLICT(group_hash) DO UPDATE SET task_id=excluded.task_id,managed=excluded.managed",
              )
              .run(group, taskId, JSON.stringify(managed));
        }
      } else if (
        !prior &&
        !needsReview &&
        analysis.confidence >= 0.85 &&
        !["spam", "newsletter"].includes(analysis.category) &&
        !["junk", "drafts", "deleted"].includes(document.role)
      ) {
        const links = this.db
          .prepare("SELECT * FROM sync_links WHERE group_hash IN(?,?)")
          .all(row.thread_hash, row.identity_hash) as {
          task_id: string | null;
          managed: string;
        }[];
        const linked = new Set(links.map((l) => l.task_id).filter(Boolean));
        const match =
          analysis.match_task_id &&
          analysis.match_confidence >= 0.92 &&
          candidateIds.has(analysis.match_task_id)
            ? analysis.match_task_id
            : null;
        const target =
          links.some((l) => !l.task_id) || linked.size > 1
            ? null
            : ([...linked][0] ?? taskId ?? match);
        if (target && !this.workflow.rejectedTask(target)) {
          this.assistant.store.addPost(
            target,
            {
              kind: "update",
              content: `AI · Källuppdatering\n${analysis.summary}\n\n${document.kind === "mail" ? "Mejl" : "Kalender"}: ${document.title}\nDatum: ${document.occurred_at}\nIndexreferens: ${row.id}`,
            },
            "assistant",
          );
          taskId = target;
          action = "updated";
          const managed =
            links.find((l) => l.task_id === target)?.managed ?? "{}";
          for (const group of [row.thread_hash, row.identity_hash])
            this.db
              .prepare("INSERT OR IGNORE INTO sync_links VALUES(?,?,?)")
              .run(group, taskId, managed);
        }
      }
      if (!prior)
        this.db
          .prepare(
            "INSERT INTO sync_receipts VALUES(?,?,?,?,?) ON CONFLICT(source_id,content_hash) DO UPDATE SET action=excluded.action,task_id=excluded.task_id,created_at=excluded.created_at",
          )
          .run(row.id, row.content_hash, action, taskId, this.time());
      this.db
        .prepare(
          "UPDATE sync_sources SET analysis=?,category=?,urgency=?,status=?,task_id=?,manual_priority=0,attempts=0,last_error=NULL WHERE id=?",
        )
        .run(
          this.calendar.sealIndex(`analysis:${row.id}`, analysis),
          analysis.category,
          analysis.urgency,
          action === "review" ? "review" : "done",
          taskId,
          row.id,
        );
      if (taskId && row.urgency !== analysis.urgency)
        this.db
          .prepare("UPDATE metadata SET revision=revision+1 WHERE id=1")
          .run();
      this.audit("analysis_applied", {
        source_id: row.id,
        kind: row.kind,
        category: analysis.category,
        urgency: analysis.urgency,
        action,
        task_id: taskId,
      });
    })();
  }
  private finishRuns() {
    const allowed = new Set(
      this.calendar
        .accounts(true)
        .filter((a) => a.connected)
        .map((a) => a.id),
    );
    for (const run of this.db
      .prepare("SELECT id FROM sync_runs WHERE status='analyzing'")
      .all() as { id: string }[]) {
      const rows = this.db
        .prepare(
          "SELECT s.status,s.account_id FROM sync_sources s JOIN sync_run_items i ON i.source_id=s.id WHERE i.run_id=?",
        )
        .all(run.id) as { status: string; account_id: string }[];
      if (rows.some((s) => !allowed.has(s.account_id))) {
        this.db
          .prepare(
            "UPDATE sync_runs SET status='failed',last_error='Kontots AI-läsning har återkallats.',finished_at=? WHERE id=?",
          )
          .run(this.time(), run.id);
      } else if (rows.every((s) => doneStates.has(s.status)))
        this.db
          .prepare("UPDATE sync_runs SET status=?,finished_at=? WHERE id=?")
          .run(
            rows.some((s) => s.status === "failed") ? "partial" : "completed",
            this.time(),
            run.id,
          );
    }
  }
  taskScores(boardId: string) {
    return this.db
      .prepare(
        "SELECT s.task_id,max(s.urgency) AS urgency_score,count(*) AS source_count FROM sync_sources s JOIN tasks t ON t.id=s.task_id JOIN columns c ON c.id=t.column_id WHERE c.board_id=? AND s.urgency IS NOT NULL AND s.status='done' GROUP BY s.task_id",
      )
      .all(boardId);
  }
  lookup(accountId: string, ids: string[]) {
    if (!this.allowed(accountId)) return [];
    const query = this.db.prepare(
      "SELECT id,status,urgency,category,task_id FROM sync_sources WHERE account_id=? AND external_hash=?",
    );
    return ids.map((external) => ({
      external_id: external,
      index:
        query.get(accountId, this.calendar.indexHash(`external:${external}`)) ??
        null,
    }));
  }
}
