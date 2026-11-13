import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import {
  createSchema,
  editSchema,
  idSchema,
  boardSchema,
  boardEditSchema,
  columnSchema,
  columnEditSchema,
  postSchema,
  sprintSchema,
  sprintEditSchema,
  toolSchemas,
} from "../shared/schema.js";
import { Store, HttpError } from "./store.js";
import { JobQueue } from "./jobs.js";
import { Assistant, newSession, type Session } from "./ai.js";

export function createApp(store: Store, assistant: Assistant) {
  const app = express();
  const queue = new JobQueue(assistant),
    knowledge = assistant.knowledge;
  app.locals.jobQueue = queue;
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      if (
        store.db.open &&
        req.path.startsWith("/api/") &&
        (req.method !== "GET" || res.statusCode >= 400)
      )
        knowledge.log(
          "http.request",
          {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration_ms: Date.now() - started,
          },
          undefined,
          res.statusCode >= 400 ? "warn" : "info",
        );
    });
    next();
  });
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    // Literal IPs support LAN access; reject arbitrary Host names (DNS rebinding).
    const hostname = req.hostname.replace(/^\[|\]$/g, "");
    if (
      hostname !== "localhost" &&
      !isIP(hostname) &&
      hostname !== process.env.HOST
    )
      return next(
        new HttpError(403, "Använd localhost eller serverns IP-adress."),
      );
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      if (!["GET", "HEAD"].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
          try {
            if (new URL(origin).host !== req.headers.host)
              return next(
                new HttpError(403, "Begäran måste komma från Kanban-sidan."),
              );
          } catch {
            return next(new HttpError(403, "Ogiltigt ursprung."));
          }
        }
        if (!req.is("application/json"))
          return next(new HttpError(415, "Använd application/json."));
      }
    }
    next();
  });
  app.use(express.json({ limit: "128kb" }));
  const sessions = new Map<string, Session>();
  function session(req: express.Request, res: express.Response) {
    const now = Date.now();
    for (const [id, value] of sessions)
      if (!value.busy && now - value.touched > 2 * 60 * 60 * 1000)
        sessions.delete(id);
    const cookie = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("kanban_chat="))
      ?.slice(12);
    let value = cookie ? sessions.get(cookie) : undefined;
    if (!value) {
      if (sessions.size >= 200)
        throw new HttpError(503, "För många AI-sessioner. Försök igen senare.");
      const id = randomUUID();
      value = newSession();
      sessions.set(id, value);
      res.cookie("kanban_chat", id, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 2 * 60 * 60 * 1000,
      });
    }
    value.touched = now;
    return value;
  }
  app.get("/api/ai/work", (_req, res) =>
    res.json({
      jobs: knowledge.jobs(),
      conversations: knowledge.conversations(),
      pending: knowledge.pending(),
      revision: store.revision(),
    }),
  );
  app.post("/api/ai/jobs", (req, res) => {
    const input = z
      .object({
        message: z.string().trim().min(1).max(8000),
        request_id: idSchema,
        conversation_id: idSchema.optional(),
        board_id: idSchema.optional(),
        task_id: idSchema.optional(),
        sprint_id: idSchema.nullable().optional(),
      })
      .strict()
      .parse(req.body);
    res.status(202).json({ job: queue.submit(input) });
  });
  app.get("/api/ai/jobs/:id", (req, res) =>
    res.json({ job: knowledge.job(idSchema.parse(req.params.id)) }),
  );
  app.post("/api/ai/jobs/:id/cancel", (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json({ job: queue.cancel(idSchema.parse(req.params.id)) });
  });
  app.post("/api/ai/jobs/:id/move", (req, res) => {
    const { direction } = z
      .object({ direction: z.enum(["up", "down"]) })
      .strict()
      .parse(req.body);
    queue.move(idSchema.parse(req.params.id), direction);
    res.json({ jobs: knowledge.jobs() });
  });
  app.post("/api/ai/jobs/:id/dismiss", (req, res) => {
    z.object({}).strict().parse(req.body);
    const job = knowledge.job(idSchema.parse(req.params.id));
    if (["queued", "running", "needs_input"].includes(job.status))
      throw new HttpError(
        409,
        "Jobbet väntar fortfarande på arbete eller svar.",
      );
    store.db.prepare("UPDATE ai_jobs SET dismissed=1 WHERE id=?").run(job.id);
    res.json({ ok: true });
  });
  app.get("/api/ai/conversations", (req, res) =>
    res.json(
      knowledge.searchConversations(
        z
          .string()
          .max(200)
          .parse(req.query.query ?? ""),
        req.query.board_id ? idSchema.parse(req.query.board_id) : undefined,
        z.coerce
          .number()
          .int()
          .min(0)
          .parse(req.query.offset ?? 0),
        30,
      ),
    ),
  );
  app.get("/api/ai/messages/:id", (req, res) => {
    const message = store.db
      .prepare("SELECT * FROM ai_messages WHERE id=?")
      .get(idSchema.parse(req.params.id));
    if (!message) throw new HttpError(404, "Meddelandet finns inte.");
    res.json({ message });
  });
  app.get("/api/ai/conversations/:id", (req, res) =>
    res.json(
      knowledge.messages(
        idSchema.parse(req.params.id),
        z.coerce
          .number()
          .int()
          .min(0)
          .parse(req.query.offset ?? 0),
        60,
      ),
    ),
  );
  app.get("/api/ai/memories", (req, res) =>
    res.json({
      memories: knowledge.memories(
        z
          .string()
          .max(200)
          .parse(req.query.query ?? ""),
        req.query.board_id ? idSchema.parse(req.query.board_id) : undefined,
        req.query.all === "true",
      ),
    }),
  );
  app.post("/api/ai/memories", (req, res) => {
    const input = z
      .object({
        key: z.string().trim().min(1).max(120),
        content: z.string().trim().min(1).max(2000),
        kind: z.enum(["preference", "fact", "decision"]).default("fact"),
        board_id: idSchema.nullable().default(null),
      })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json({ memory: knowledge.saveMemory({ ...input, source: "manual" }) });
  });
  app.delete("/api/ai/memories/:id", (req, res) => {
    z.object({}).strict().parse(req.body);
    knowledge.forget(idSchema.parse(req.params.id));
    res.json({ ok: true });
  });
  app.get("/api/ai/logs", (req, res) =>
    res.json(
      knowledge.logs({
        job_id: req.query.job_id ? idSchema.parse(req.query.job_id) : undefined,
        level: req.query.level
          ? z.enum(["info", "warn", "error"]).parse(req.query.level)
          : undefined,
        query: z
          .string()
          .max(200)
          .parse(req.query.query ?? ""),
        offset: z.coerce
          .number()
          .int()
          .min(0)
          .parse(req.query.offset ?? 0),
        limit: 50,
      }),
    ),
  );
  function resolveConfirmationJob(jobId: string | null) {
    if (jobId && !knowledge.pending().some((p) => p.job_id === jobId))
      store.db
        .prepare(
          "UPDATE ai_jobs SET status='completed',progress='Bekräftelse hanterad' WHERE id=? AND status='needs_input'",
        )
        .run(jobId);
  }
  app.post("/api/ai/confirmations/:id", (req, res) => {
    const { approve } = z
        .object({ approve: z.boolean() })
        .strict()
        .parse(req.body),
      confirmation = knowledge.confirmation(idSchema.parse(req.params.id));
    if (!approve) {
      store.db
        .prepare("UPDATE ai_confirmations SET status='rejected' WHERE id=?")
        .run(confirmation.id);
      knowledge.log(
        "deletion.rejected",
        { id: confirmation.id },
        confirmation.job_id ?? undefined,
      );
      resolveConfirmationJob(confirmation.job_id);
      return res.json({ ok: true });
    }
    if (confirmation.kind === "board")
      queue.protectBoard(confirmation.target_id);
    const current =
      confirmation.kind === "task"
        ? store.get(confirmation.target_id)
        : store.board(confirmation.target_id);
    if (JSON.stringify(current) !== confirmation.snapshot) {
      store.db
        .prepare("UPDATE ai_confirmations SET status='stale' WHERE id=?")
        .run(confirmation.id);
      knowledge.log(
        "deletion.stale",
        { id: confirmation.id, target_id: confirmation.target_id },
        confirmation.job_id ?? undefined,
        "warn",
      );
      if (confirmation.job_id)
        store.db
          .prepare(
            "UPDATE ai_jobs SET status='failed',error='Bekräftelsen har blivit inaktuell',progress='Ny bekräftelse krävs' WHERE id=? AND status='needs_input'",
          )
          .run(confirmation.job_id);
      throw new HttpError(
        409,
        "Innehållet har ändrats sedan begäran. Öppna objektet och bekräfta borttagningen igen.",
      );
    }
    const workspace = store.db.transaction(() => {
      let workspace;
      if (confirmation.kind === "board")
        workspace = store.deleteBoard(confirmation.target_id);
      else {
        const task = store.get(confirmation.target_id);
        store.delete(task.id);
        workspace = store.workspace(task.board_id);
      }
      store.db
        .prepare("UPDATE ai_confirmations SET status='approved' WHERE id=?")
        .run(confirmation.id);
      knowledge.log(
        "deletion.approved",
        {
          id: confirmation.id,
          kind: confirmation.kind,
          target_id: confirmation.target_id,
        },
        confirmation.job_id ?? undefined,
      );
      resolveConfirmationJob(confirmation.job_id);
      if (confirmation.conversation_id && confirmation.job_id)
        knowledge.append(
          confirmation.conversation_id,
          confirmation.job_id,
          "assistant",
          `Tog bort ${confirmation.kind === "board" ? "tavlan" : "kortet"} ”${confirmation.name}” efter din bekräftelse.`,
        );
      return workspace;
    })();
    res.json({ ok: true, workspace });
  });
  app.delete("/api/boards/:id", (req, res) => {
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    const id = idSchema.parse(req.params.id);
    queue.protectBoard(id);
    const board = store.board(id),
      workspace = store.deleteBoard(id);
    knowledge.log("board.deleted", { id, name: board.name });
    res.json({ workspace });
  });
  app.get("/api/boards", (_req, res) => res.json({ boards: store.boards() }));
  app.get("/api/boards/:id", (req, res) =>
    res.json(store.workspace(idSchema.parse(req.params.id))),
  );
  app.post("/api/boards", (req, res) => {
    const board = store.createBoard(boardSchema.parse(req.body));
    res.status(201).json({ board, workspace: store.workspace(board.id) });
  });
  app.patch("/api/boards/:id", (req, res) => {
    const board = store.updateBoard(
      idSchema.parse(req.params.id),
      boardEditSchema.parse(req.body),
    );
    res.json({ board, workspace: store.workspace(board.id) });
  });
  app.post("/api/boards/:id/columns", (req, res) => {
    const column = store.createColumn(
      idSchema.parse(req.params.id),
      columnSchema.parse(req.body),
    );
    res
      .status(201)
      .json({ column, workspace: store.workspace(column.board_id) });
  });
  app.patch("/api/columns/:id", (req, res) => {
    const column = store.updateColumn(
      idSchema.parse(req.params.id),
      columnEditSchema.parse(req.body),
    );
    res.json({ column, workspace: store.workspace(column.board_id) });
  });
  app.post("/api/boards/:id/sprints", (req, res) => {
    const sprint = store.createSprint(
      idSchema.parse(req.params.id),
      sprintSchema.parse(req.body),
    );
    res
      .status(201)
      .json({ sprint, workspace: store.workspace(sprint.board_id) });
  });
  app.patch("/api/sprints/:id", (req, res) => {
    const sprint = store.updateSprint(
      idSchema.parse(req.params.id),
      sprintEditSchema.parse(req.body),
    );
    res.json({ sprint, workspace: store.workspace(sprint.board_id) });
  });
  for (const [action, state] of [
    ["start", "active"],
    ["complete", "completed"],
  ] as const)
    app.post(`/api/sprints/:id/${action}`, (req, res) => {
      z.object({}).strict().parse(req.body);
      const sprint = store.transitionSprint(
        idSchema.parse(req.params.id),
        state,
      );
      res.json({ sprint, workspace: store.workspace(sprint.board_id) });
    });
  app.post("/api/sprint-assignments", (req, res) => {
    const { task_ids, sprint_id } = toolSchemas.assign_to_sprint.parse(
      req.body,
    );
    const tasks = store.assignSprint(task_ids, sprint_id);
    res.json({ tasks, workspace: store.workspace(tasks[0].board_id) });
  });
  app.get("/api/tasks", (req, res) =>
    res.json({
      tasks: store.list(
        req.query.board_id ? idSchema.parse(req.query.board_id) : undefined,
      ),
    }),
  );
  app.get("/api/tasks/:id", (req, res) =>
    res.json(
      store.detail(
        idSchema.parse(req.params.id),
        req.query.before
          ? z.coerce.number().int().positive().parse(req.query.before)
          : undefined,
      ),
    ),
  );
  app.post("/api/tasks/:id/posts", (req, res) => {
    const id = idSchema.parse(req.params.id);
    const post = store.addPost(id, postSchema.parse(req.body), "user");
    res.status(201).json({
      post,
      ...store.detail(id),
      workspace: store.workspace(store.get(id).board_id),
    });
  });
  app.post("/api/tasks", (req, res) => {
    const task = store.create(createSchema.parse(req.body));
    res.status(201).json({
      task,
      tasks: store.list(task.board_id),
      workspace: store.workspace(task.board_id),
    });
  });
  app.patch("/api/tasks/:id", (req, res) => {
    const task = store.update(
      idSchema.parse(req.params.id),
      editSchema.parse(req.body),
    );
    res.json({
      task,
      tasks: store.list(task.board_id),
      workspace: store.workspace(task.board_id),
    });
  });
  app.delete("/api/tasks/:id", (req, res) => {
    const id = idSchema.parse(req.params.id);
    const boardId = store.get(id).board_id;
    const body = z
      .object({ confirmed: z.literal(true), request_id: idSchema.optional() })
      .strict()
      .parse(req.body);
    if (body.request_id) {
      const current = session(req, res);
      const pending = current.pending.get(body.request_id);
      if (!pending || pending.task.id !== id)
        throw new HttpError(
          409,
          "Borttagningsbegäran har gått ut. Be assistenten försöka igen.",
        );
      const task = store.get(id);
      if (JSON.stringify(task) !== JSON.stringify(pending.task)) {
        current.pending.delete(body.request_id);
        throw new HttpError(
          409,
          "Uppgiften har ändrats. Öppna kortet och bekräfta borttagningen igen.",
        );
      }
      store.delete(id);
      current.pending.delete(body.request_id);
    } else store.delete(id);
    res.json({
      tasks: store.list(boardId),
      workspace: store.workspace(boardId),
    });
  });
  app.post("/api/ai/deletions/:id/cancel", (req, res) => {
    session(req, res).pending.delete(idSchema.parse(req.params.id));
    res.json({ ok: true });
  });
  app.get("/api/ai/help", (_req, res) => res.json(assistant.help()));
  app.get("/api/ai/status", async (_req, res) =>
    res.json(await assistant.status()),
  );
  app.post("/api/ai/chat", async (req, res) => {
    const { message, board_id, task_id, sprint_id } = z
      .object({
        message: z.string().trim().min(1).max(8000),
        board_id: idSchema.optional(),
        task_id: idSchema.optional(),
        sprint_id: idSchema.nullable().optional(),
      })
      .strict()
      .parse(req.body);
    const boardId = board_id ?? store.defaultBoardId();
    store.board(boardId);
    if (task_id && store.get(task_id).board_id !== boardId)
      throw new HttpError(400, "Det valda kortet tillhör en annan tavla.");
    if (sprint_id && store.sprint(sprint_id).board_id !== boardId)
      throw new HttpError(400, "Sprinten tillhör en annan tavla.");
    const current = session(req, res);
    if (current.busy)
      throw new HttpError(409, "Vänta tills assistenten svarat.");
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    res.status(200).type("application/x-ndjson");
    res.flushHeaders();
    await assistant.chat(
      message,
      current,
      (event) => {
        if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
      },
      abort.signal,
      { board_id: boardId, task_id, sprint_id },
    );
    res.end();
  });
  app.use("/api", (_req, _res, next) =>
    next(new HttpError(404, "API-adressen finns inte.")),
  );
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" "),
      });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Ogiltig JSON." });
      return;
    }
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "Förfrågan är för stor." });
      return;
    }
    console.error(
      "Kanban:",
      error instanceof Error ? error.message : "Okänt fel",
    );
    res.status(500).json({
      error: "Det gick inte att spara eller läsa uppgifterna. Försök igen.",
    });
  };
  app.use(errors);
  return app;
}
