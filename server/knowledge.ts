import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import { HttpError } from "./store.js";
import type {
  AiJob,
  Conversation,
  ChatMessage,
  Memory,
  AuditLog,
  Confirmation,
} from "../shared/schema.js";

const now = () => new Date().toISOString();
export function scrub(value: unknown): any {
  if (typeof value === "string")
    return value
      .replace(
        /((?:password|lösenord|token|api[_ -]?key|secret|authorization)\s*[:=]\s*)(?:"[^"\n]*"|\S+)/gi,
        "$1[REDACTED]",
      )
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|hvs\.[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
        "[REDACTED]",
      );
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /password|token|secret|authorization|cookie|api[_-]?key|credential|lösenord/i.test(
          key,
        ) && !(typeof v === "number" && /(?:tokens|token_count)$/.test(key))
          ? "[REDACTED]"
          : scrub(v),
      ]),
    );
  return value;
}
const like = (s: string) => "%" + s.replace(/[\\%_]/g, "\\$&") + "%";
export class Knowledge {
  constructor(readonly store: Store) {
    store.db.exec(`
 CREATE TABLE IF NOT EXISTS ai_worker(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,board_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS ai_jobs(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL REFERENCES ai_conversations(id),board_id TEXT NOT NULL,task_id TEXT,sprint_id TEXT,message TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'understanding',position INTEGER NOT NULL,progress TEXT NOT NULL DEFAULT '',result TEXT NOT NULL DEFAULT '',error TEXT,receipts TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,dismissed INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS ai_jobs_queue ON ai_jobs(status,position);
 CREATE TABLE IF NOT EXISTS ai_external_context(job_id TEXT PRIMARY KEY REFERENCES ai_jobs(id), context TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES ai_conversations(id),job_id TEXT NOT NULL REFERENCES ai_jobs(id),role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages(conversation_id,created_at);
 CREATE TABLE IF NOT EXISTS ai_memories(id TEXT PRIMARY KEY,key TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,board_id TEXT,source_message_id TEXT,source TEXT NOT NULL,uses INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS ai_memory_key ON ai_memories(COALESCE(board_id,''),key);
 CREATE TABLE IF NOT EXISTS ai_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT,level TEXT NOT NULL,event TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS ai_logs_job ON ai_logs(job_id,id);
 CREATE TABLE IF NOT EXISTS ai_confirmations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,target_id TEXT NOT NULL,name TEXT NOT NULL,snapshot TEXT NOT NULL,job_id TEXT,conversation_id TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
 `);
  }
  log(
    event: string,
    detail: unknown = {},
    jobId?: string,
    level: "info" | "warn" | "error" = "info",
  ) {
    this.store.db
      .prepare(
        "INSERT INTO ai_logs(job_id,level,event,detail,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        jobId ?? null,
        level,
        event,
        JSON.stringify(scrub(detail)).slice(0, 20000),
        now(),
      );
  }
  logs(
    input: {
      job_id?: string;
      level?: string;
      query?: string;
      offset?: number;
      limit?: number;
    } = {},
  ) {
    const where =
      " WHERE (? IS NULL OR job_id=?) AND (? IS NULL OR level=?) AND (event LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')";
    const params = [
      input.job_id ?? null,
      input.job_id ?? null,
      input.level ?? null,
      input.level ?? null,
      like(input.query ?? ""),
      like(input.query ?? ""),
    ];
    const rows = this.store.db
      .prepare(
        "SELECT * FROM ai_logs" + where + " ORDER BY id DESC LIMIT ? OFFSET ?",
      )
      .all(...params, input.limit ?? 30, input.offset ?? 0) as AuditLog[];
    return {
      logs: rows,
      next_offset:
        rows.length === (input.limit ?? 30)
          ? (input.offset ?? 0) + rows.length
          : null,
    };
  }
  conversation(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM ai_conversations WHERE id=?")
      .get(id) as Conversation | undefined;
    if (!row) throw new HttpError(404, "Konversationen finns inte.");
    return row;
  }
  conversations() {
    return this.store.db
      .prepare(
        "SELECT * FROM ai_conversations ORDER BY updated_at DESC,rowid DESC LIMIT 60",
      )
      .all() as Conversation[];
  }
  messages(id: string, offset = 0, limit = 60) {
    this.conversation(id);
    const rows = this.store.db
      .prepare(
        "SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY created_at,rowid LIMIT ? OFFSET ?",
      )
      .all(id, limit + 1, offset) as ChatMessage[];
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      conversation: this.conversation(id),
      messages: rows,
      next_offset: more ? offset + limit : null,
    };
  }
  searchConversations(query = "", boardId?: string, offset = 0, limit = 30) {
    const rows = this.store.db
      .prepare(
        "SELECT m.*,c.title,j.board_id,j.status AS job_status FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id JOIN ai_jobs j ON j.id=m.job_id WHERE (? IS NULL OR j.board_id=?) AND (m.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\') ORDER BY m.created_at DESC,m.rowid DESC LIMIT ? OFFSET ?",
      )
      .all(
        boardId ?? null,
        boardId ?? null,
        like(query),
        like(query),
        limit + 1,
        offset,
      ) as (ChatMessage & { title: string; board_id: string | null })[];
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      messages: rows.map((r) => ({ ...r, content: r.content.slice(0, 1600) })),
      next_offset: more ? offset + limit : null,
    };
  }
  append(
    conversationId: string,
    jobId: string,
    role: "user" | "assistant",
    content: string,
  ) {
    const id = randomUUID(),
      date = now();
    this.store.db
      .prepare("INSERT INTO ai_messages VALUES(?,?,?,?,?,?)")
      .run(id, conversationId, jobId, role, scrub(content), date);
    this.store.db
      .prepare("UPDATE ai_conversations SET updated_at=? WHERE id=?")
      .run(date, conversationId);
    return id;
  }
  jobs() {
    return (
      this.store.db
        .prepare(
          "SELECT * FROM ai_jobs WHERE dismissed=0 ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'needs_input' THEN 2 ELSE 3 END,CASE WHEN status='queued' THEN position END,created_at DESC LIMIT 100",
        )
        .all() as any[]
    ).map(this.parseJob);
  }
  private parseJob(row: any): AiJob {
    return { ...row, receipts: JSON.parse(row.receipts) };
  }
  job(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM ai_jobs WHERE id=?")
      .get(id);
    if (!row) throw new HttpError(404, "AI-jobbet finns inte.");
    const context = this.store.db
      .prepare("SELECT context FROM ai_external_context WHERE job_id=?")
      .get(id) as { context: string } | undefined;
    return {
      ...this.parseJob(row),
      ...(context ? { external_context: JSON.parse(context.context) } : {}),
    };
  }
  memories(query = "", boardId?: string, all = false) {
    return this.store.db
      .prepare(
        "SELECT * FROM ai_memories WHERE deleted=0 AND (?=1 OR board_id IS NULL OR board_id=?) AND (key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY CASE WHEN board_id=? THEN 0 ELSE 1 END,updated_at DESC LIMIT 40",
      )
      .all(
        all ? 1 : 0,
        boardId ?? null,
        like(query),
        like(query),
        boardId ?? null,
      ) as Memory[];
  }
  memory(id: string) {
    const memory = this.store.db
      .prepare("SELECT * FROM ai_memories WHERE id=? AND deleted=0")
      .get(id) as Memory | undefined;
    if (!memory) throw new HttpError(404, "Minnet finns inte.");
    return memory;
  }
  saveMemory(
    input: {
      key: string;
      content: string;
      kind: string;
      board_id: string | null;
      source_message_id?: string | null;
      source: string;
    },
    jobId?: string,
  ) {
    if (input.board_id) this.store.board(input.board_id);
    if (input.source_message_id) {
      const source = this.store.db
        .prepare("SELECT * FROM ai_messages WHERE id=? AND role='user'")
        .get(input.source_message_id) as ChatMessage | undefined;
      if (!source)
        throw new HttpError(
          400,
          "Minnet måste ha ett verkligt användarmeddelande som källa.",
        );
    }
    const clean = scrub(input.content);
    if (clean.includes("[REDACTED]"))
      throw new HttpError(400, "Hemligheter får inte sparas som AI-minne.");
    const old = this.store.db
      .prepare(
        "SELECT id FROM ai_memories WHERE COALESCE(board_id,'')=COALESCE(?,'') AND key=?",
      )
      .get(input.board_id, input.key) as { id: string } | undefined;
    const id = old?.id ?? randomUUID(),
      date = now();
    this.store.db
      .prepare(
        "INSERT INTO ai_memories(id,key,content,kind,board_id,source_message_id,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,kind=excluded.kind,source_message_id=excluded.source_message_id,source=excluded.source,deleted=0,updated_at=excluded.updated_at",
      )
      .run(
        id,
        input.key,
        clean,
        input.kind,
        input.board_id,
        input.source_message_id ?? null,
        input.source,
        date,
        date,
      );
    this.log(
      "memory.saved",
      {
        id,
        key: input.key,
        source: input.source,
        source_message_id: input.source_message_id,
      },
      jobId,
    );
    return this.memory(id);
  }
  forget(id: string, jobId?: string) {
    this.memory(id);
    this.store.db
      .prepare("UPDATE ai_memories SET deleted=1,updated_at=? WHERE id=?")
      .run(now(), id);
    this.log("memory.forgotten", { id }, jobId);
  }
  context(boardId: string, message: string) {
    const terms = message.toLocaleLowerCase().match(/[\p{L}\d]{4,}/gu) ?? [];
    const memories = this.memories("", boardId)
      .sort((a, b) => {
        const score = (m: Memory) =>
          terms.filter((t) =>
            (m.key + " " + m.content).toLowerCase().includes(t),
          ).length +
          (m.board_id === boardId ? 1 : 0) +
          (m.kind === "preference" ? 2 : 0);
        return score(b) - score(a);
      })
      .slice(0, 6);
    for (const memory of memories)
      this.store.db
        .prepare("UPDATE ai_memories SET uses=uses+1 WHERE id=?")
        .run(memory.id);
    return {
      memories: memories.map((m) => ({
        ...m,
        content: m.content.slice(0, 700),
      })),
      recent_work: (
        this.store.db
          .prepare(
            "SELECT id,conversation_id,message,status,result,finished_at FROM ai_jobs WHERE board_id=? AND status IN ('completed','failed','needs_input','interrupted') ORDER BY created_at DESC,rowid DESC LIMIT 3",
          )
          .all(boardId) as { id: string; message: string; result: string }[]
      ).map((job) => ({
        ...job,
        message: job.message.slice(0, 300),
        result: job.result.slice(0, 900),
      })),
    };
  }
  lesson(tool: string, error: string, jobId?: string) {
    const key =
      "tool:" +
      tool +
      ":" +
      (error.includes("UUID") || error.includes("uuid")
        ? "uuid"
        : error.includes("kolumn")
          ? "column"
          : "validation");
    return this.saveMemory(
      {
        key,
        content: `Erfarenhet från verktygskontroll: ${tool}: ${String(scrub(error)).includes("[REDACTED]") ? "Argumenten kunde inte godkännas. Läs maskerade loggar." : scrub(error).slice(0, 700)}. Läs aktuella data, använd riktiga UUID från verktygsresultat och upprepa inte lyckade skapanden.`,
        kind: "lesson",
        board_id: null,
        source: "tool_feedback",
      },
      jobId,
    );
  }
  propose(
    kind: "task" | "board",
    id: string,
    jobId?: string,
    conversationId?: string,
  ) {
    const target = kind === "task" ? this.store.get(id) : this.store.board(id);
    if (kind === "task") this.store.ensureDeletable(id);
    else this.store.ensureBoardDeletable(id);
    const prior = this.store.db
      .prepare(
        "SELECT * FROM ai_confirmations WHERE kind=? AND target_id=? AND status='pending'",
      )
      .get(kind, id) as Confirmation | undefined;
    if (prior && prior.snapshot === JSON.stringify(target)) return prior;
    const proposal: Confirmation = {
      id: randomUUID(),
      kind,
      target_id: id,
      name: "title" in target ? target.title : target.name,
      snapshot: JSON.stringify(target),
      job_id: jobId ?? null,
      conversation_id: conversationId ?? null,
      status: "pending",
      created_at: now(),
    };
    this.store.db
      .prepare(
        "INSERT INTO ai_confirmations VALUES(@id,@kind,@target_id,@name,@snapshot,@job_id,@conversation_id,@status,@created_at)",
      )
      .run(proposal);
    this.log("deletion.proposed", { kind, id, name: proposal.name }, jobId);
    return proposal;
  }
  pending() {
    return this.store.db
      .prepare(
        "SELECT * FROM ai_confirmations WHERE status='pending' ORDER BY created_at",
      )
      .all() as Confirmation[];
  }
  confirmation(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM ai_confirmations WHERE id=? AND status='pending'")
      .get(id) as Confirmation | undefined;
    if (!row) throw new HttpError(404, "Bekräftelsen finns inte längre.");
    return row;
  }
}
