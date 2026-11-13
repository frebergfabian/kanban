import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { newSession, type Assistant, type Session } from "./ai.js";
import { HttpError } from "./store.js";
import type { AiJob, ChatContext, ChatEvent } from "../shared/schema.js";
import { scrub } from "./knowledge.js";
const date = () => new Date().toISOString();
export class JobQueue {
  private running?: { id: string; abort: AbortController; session?: Session };
  private readonly owner = randomUUID();
  private scheduled = false;
  private closed = false;
  private processing?: Promise<void>;
  constructor(readonly assistant: Assistant) {
    const k = assistant.knowledge;
    k.store.db.transaction(() => {
      const previous = k.store.db
        .prepare("SELECT * FROM ai_worker WHERE id=1")
        .get() as { owner: string; pid: number; host: string } | undefined;
      if (previous) {
        let alive = previous.host !== hostname();
        if (!alive) {
          try {
            process.kill(previous.pid, 0);
            alive = true;
          } catch (error) {
            alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
          }
        }
        if (alive)
          throw new HttpError(
            409,
            "AI-kön används redan av en körande server. Stoppa den innan du startar en andra instans.",
          );
      }
      k.store.db
        .prepare(
          "INSERT INTO ai_worker VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid,host=excluded.host",
        )
        .run(this.owner, process.pid, hostname());
    })();
    for (const row of k.store.db
      .prepare("SELECT id,conversation_id FROM ai_jobs WHERE status='running'")
      .all() as { id: string; conversation_id: string }[]) {
      const result =
        "Servern startades om medan jobbet kördes. Redan sparade ändringar finns kvar. Kontrollera tavlan och starta ett nytt jobb för återstående arbete.";
      k.store.db
        .prepare(
          "UPDATE ai_jobs SET status='interrupted',error=?,result=?,finished_at=? WHERE id=?",
        )
        .run(result, result, date(), row.id);
      k.append(row.conversation_id, row.id, "assistant", result);
      k.log("job.interrupted", { reason: "server_restart" }, row.id, "warn");
    }
    this.kick();
  }
  submit(
    input: {
      message: string;
      request_id: string;
      conversation_id?: string;
    } & ChatContext,
  ) {
    const k = this.assistant.knowledge,
      db = k.store.db;
    const existing = db
      .prepare("SELECT id FROM ai_jobs WHERE request_id=?")
      .get(input.request_id) as { id: string } | undefined;
    if (existing) return k.job(existing.id);
    if (
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM ai_jobs WHERE status IN ('queued','running')",
          )
          .get() as { n: number }
      ).n >= 30
    )
      throw new HttpError(429, "Kön är full. Vänta tills några jobb är klara.");
    const boardId = input.board_id ?? k.store.defaultBoardId();
    k.store.board(boardId);
    if (input.task_id && k.store.get(input.task_id).board_id !== boardId)
      throw new HttpError(400, "Det valda kortet tillhör en annan tavla.");
    if (input.sprint_id && k.store.sprint(input.sprint_id).board_id !== boardId)
      throw new HttpError(400, "Sprinten tillhör en annan tavla.");
    const conversationId = input.conversation_id ?? randomUUID();
    if (input.conversation_id) k.conversation(conversationId);
    const id = randomUUID(),
      created = date();
    db.transaction(() => {
      if (!input.conversation_id)
        db.prepare(
          "INSERT INTO ai_conversations(id,title,board_id,created_at,updated_at) VALUES(?,?,?,?,?)",
        ).run(
          conversationId,
          scrub(input.message).slice(0, 100),
          boardId,
          created,
          created,
        );
      db.prepare(
        "INSERT INTO ai_jobs(id,request_id,conversation_id,board_id,task_id,sprint_id,message,status,position,progress,created_at) VALUES(?,?,?,?,?,?,?,'queued',(SELECT COALESCE(max(position),0)+1 FROM ai_jobs),'Väntar i kön',?)",
      ).run(
        id,
        input.request_id,
        conversationId,
        boardId,
        input.task_id ?? null,
        input.sprint_id ?? null,
        scrub(input.message),
        created,
      );
      k.append(conversationId, id, "user", input.message);
      db.prepare(
        "UPDATE ai_jobs SET status='completed',progress='Besvarad i ett nytt jobb' WHERE conversation_id=? AND status='needs_input'",
      ).run(conversationId);
      k.log(
        "job.queued",
        { board_id: boardId, conversation_id: conversationId },
        id,
      );
    })();
    this.kick();
    return k.job(id);
  }
  private kick() {
    if (this.closed || this.scheduled || this.running) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.processing = this.next();
    });
  }
  private async next() {
    if (this.closed || this.running || !this.assistant.store.db.open) return;
    const k = this.assistant.knowledge;
    const row = k.store.db
      .prepare(
        "SELECT id FROM ai_jobs WHERE status='queued' ORDER BY position,created_at LIMIT 1",
      )
      .get() as { id: string } | undefined;
    if (!row) return;
    const job = k.job(row.id),
      abort = new AbortController();
    this.running = { id: job.id, abort };
    k.store.db
      .prepare(
        "UPDATE ai_jobs SET status='running',started_at=?,progress='Förstår uppgiften…' WHERE id=?",
      )
      .run(date(), job.id);
    k.log(
      "job.started",
      { message: job.message, board_id: job.board_id },
      job.id,
    );
    const session = newSession();
    this.running.session = session;
    session.jobId = job.id;
    session.conversationId = job.conversation_id;
    const history = k.store.db
      .prepare(
        "SELECT m.role,m.content,j.status,j.board_id FROM ai_messages m JOIN ai_jobs j ON j.id=m.job_id WHERE m.conversation_id=? AND m.job_id!=? AND j.status NOT IN ('queued','running') ORDER BY m.created_at DESC,m.rowid DESC LIMIT 8",
      )
      .all(job.conversation_id, job.id) as {
      role: "user" | "assistant";
      content: string;
      status: string;
      board_id: string;
    }[];
    session.history = history.reverse().map((m) => ({
      role: m.role,
      content:
        `[Tidigare jobb: ${m.status}; tavla ${m.board_id}]\n` +
        m.content.slice(0, 1200) +
        (m.content.length > 1200
          ? "\n[Förkortat; läs get_conversation för hela underlaget.]"
          : ""),
    }));
    session.sourceMessageId = (
      k.store.db
        .prepare("SELECT id FROM ai_messages WHERE job_id=? AND role='user'")
        .get(job.id) as { id: string }
    ).id;
    let final: Extract<ChatEvent, { type: "done" }> | undefined;
    try {
      await this.assistant.chat(
        job.message,
        session,
        (event) => {
          if (event.type === "progress") {
            const stage =
              /^(Skapar|Flyttar|Publicerar|Planerar|Startar|Avslutar|Uppdaterar|Sparar|Glömmer|Förbereder)/.test(
                event.message,
              )
                ? "working"
                : undefined;
            k.store.db
              .prepare(
                "UPDATE ai_jobs SET progress=?,stage=CASE WHEN ?='working' THEN 'working' ELSE stage END WHERE id=? AND status='running'",
              )
              .run(event.message, stage ?? "", job.id);
          }
          if (event.type === "receipt") {
            const receipts = k.job(job.id).receipts;
            receipts.push(scrub(event.message));
            k.store.db
              .prepare(
                "UPDATE ai_jobs SET receipts=?,stage='working' WHERE id=?",
              )
              .run(JSON.stringify(receipts), job.id);
          }
          if (event.type === "done") final = event;
        },
        abort.signal,
        {
          board_id: job.board_id,
          ...(job.task_id ? { task_id: job.task_id } : {}),
          ...(job.sprint_id ? { sprint_id: job.sprint_id } : {}),
        },
      );
      const prior = k.job(job.id).status;
      const status = ["cancelled", "interrupted"].includes(prior)
        ? prior
        : final?.error
          ? "failed"
          : final?.awaiting_input ||
              k.pending().some((p) => p.job_id === job.id)
            ? "needs_input"
            : "completed";
      const result = final?.message ?? "Inget resultat returnerades.";
      k.store.db
        .prepare(
          "UPDATE ai_jobs SET status=?,result=?,error=?,receipts=?,finished_at=?,progress=? WHERE id=?",
        )
        .run(
          status,
          scrub(result),
          scrub(final?.error ?? null),
          JSON.stringify(scrub(final?.receipts ?? [])),
          date(),
          status === "needs_input"
            ? "Behöver ditt svar"
            : status === "completed"
              ? "Klart"
              : status === "cancelled"
                ? "Avbrutet"
                : "Misslyckades",
          job.id,
        );
      k.append(job.conversation_id, job.id, "assistant", result);
      k.store.db
        .prepare("UPDATE ai_conversations SET summary=? WHERE id=?")
        .run(scrub(result).slice(0, 1800), job.conversation_id);
      k.log(
        "job." + status,
        { receipts: final?.receipts ?? [], error: final?.error },
        job.id,
        final?.error ? "error" : "info",
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Jobbet misslyckades.";
      k.store.db
        .prepare(
          "UPDATE ai_jobs SET status=CASE WHEN status IN ('cancelled','interrupted') THEN status ELSE 'failed' END,error=?,result=?,finished_at=?,progress='Misslyckades' WHERE id=?",
        )
        .run(message, message, date(), job.id);
      k.append(job.conversation_id, job.id, "assistant", message);
      k.log("job.failed", { error: message }, job.id, "error");
    } finally {
      this.running = undefined;
      this.kick();
    }
  }
  cancel(id: string) {
    const k = this.assistant.knowledge,
      job = k.job(id);
    if (!["queued", "running"].includes(job.status))
      throw new HttpError(409, "Jobbet körs inte längre.");
    k.store.db
      .prepare(
        "UPDATE ai_jobs SET status='cancelled',progress='Avbrutet',finished_at=? WHERE id=?",
      )
      .run(date(), id);
    k.log("job.cancelled", {}, id, "warn");
    if (this.running?.id === id) this.running.abort.abort();
    else
      k.append(
        job.conversation_id,
        id,
        "assistant",
        "Jobbet avbröts innan det startade.",
      );
    return k.job(id);
  }
  move(id: string, direction: "up" | "down") {
    const k = this.assistant.knowledge;
    if (k.job(id).status !== "queued")
      throw new HttpError(409, "Endast köade jobb kan flyttas.");
    k.store.db.transaction(() => {
      const ids = (
        k.store.db
          .prepare(
            "SELECT id FROM ai_jobs WHERE status='queued' ORDER BY position",
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
      const index = ids.indexOf(id),
        next = index + (direction === "up" ? -1 : 1);
      if (next >= 0 && next < ids.length)
        [ids[index], ids[next]] = [ids[next], ids[index]];
      ids.forEach((job, index) =>
        k.store.db
          .prepare("UPDATE ai_jobs SET position=? WHERE id=?")
          .run(index, job),
      );
    })();
    k.log("job.reordered", { direction }, id);
  }
  protectBoard(id: string) {
    if (this.running?.session?.boardId === id)
      throw new HttpError(
        409,
        "Tavlan används av ett körande AI-jobb. Avbryt jobbet först.",
      );
    if (
      this.assistant.knowledge.store.db
        .prepare(
          "SELECT id FROM ai_jobs WHERE board_id=? AND status IN ('queued','running') LIMIT 1",
        )
        .get(id)
    )
      throw new HttpError(
        409,
        "Tavlan har köade eller körande AI-jobb. Avbryt dem innan du tar bort tavlan.",
      );
  }
  async close() {
    this.closed = true;
    if (this.running && this.assistant.store.db.open) {
      this.assistant.store.db
        .prepare(
          "UPDATE ai_jobs SET status='interrupted',progress='Servern stängs av' WHERE id=? AND status='running'",
        )
        .run(this.running.id);
      this.running.abort.abort();
    }
    await this.processing;
    if (this.assistant.store.db.open)
      this.assistant.store.db
        .prepare("DELETE FROM ai_worker WHERE owner=?")
        .run(this.owner);
  }
}
