import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  boardSchema,
  boardEditSchema,
  columnSchema,
  columnEditSchema,
  createSchema,
  editSchema,
  postSchema,
  sprintSchema,
  sprintEditSchema,
  type Sprint,
  type ChildBoard,
  type BoardInfo,
  type Column,
  type NewTask,
  type Post,
  type Task,
  type TaskPatch,
  type TaskDetail,
  type Workspace,
} from "../shared/schema.js";
import type { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Author = "user" | "assistant" | "system";
const taskSelect = `SELECT t.*, c.board_id, c.key AS status,
  (SELECT count(*) FROM posts p WHERE p.task_id=t.id AND p.kind!='event') AS post_count,
  (SELECT substr(content,1,240) FROM posts p WHERE p.task_id=t.id AND p.kind!='event' ORDER BY seq DESC LIMIT 1) AS latest_post
  FROM tasks t JOIN columns c ON c.id=t.column_id`;
const taskTable = `CREATE TABLE tasks (
  id TEXT PRIMARY KEY, column_id TEXT NOT NULL REFERENCES columns(id), title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL CHECK(priority IN ('low','normal','high')),
  due_date TEXT, position INTEGER NOT NULL CHECK(position>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`;
export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.transaction(() => {
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS columns (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', is_done INTEGER NOT NULL DEFAULT 0 CHECK(is_done IN (0,1)), position INTEGER NOT NULL CHECK(position>=0), UNIQUE(board_id,key));
        CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO metadata VALUES (1,0);`);
      if (!this.db.prepare("SELECT id FROM boards LIMIT 1").get())
        this.insertBoard(boardSchema.parse({ name: "Min tavla" }));
      const old = this.db.prepare("PRAGMA table_info(tasks)").all() as {
        name: string;
      }[];
      if (old.length && !old.some((c) => c.name === "column_id")) {
        this.db.exec("ALTER TABLE tasks RENAME TO tasks_legacy");
        this.db.exec(taskTable);
        this.db
          .prepare(
            `INSERT INTO tasks (id,column_id,title,description,priority,due_date,position,created_at,updated_at)
          SELECT t.id,c.id,t.title,t.description,t.priority,t.due_date,t.position,t.created_at,t.updated_at
          FROM tasks_legacy t JOIN columns c ON c.key=t.status AND c.board_id=?`,
          )
          .run(this.defaultBoardId());
        const previous = (
          this.db.prepare("SELECT count(*) AS n FROM tasks_legacy").get() as {
            n: number;
          }
        ).n;
        if (
          (
            this.db.prepare("SELECT count(*) AS n FROM tasks").get() as {
              n: number;
            }
          ).n !== previous
        )
          throw new Error("Migreringen kunde inte bevara alla kort.");
        this.db.exec("DROP TABLE tasks_legacy");
      } else if (!old.length) this.db.exec(taskTable);
      this.db
        .exec(`CREATE INDEX IF NOT EXISTS tasks_order ON tasks(column_id,position);
        CREATE TABLE IF NOT EXISTS posts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('note','update','event')), author TEXT NOT NULL CHECK(author IN ('user','assistant','system')), content TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS posts_task ON posts(task_id,seq DESC);
        CREATE TABLE IF NOT EXISTS task_transitions(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,title TEXT NOT NULL,from_column TEXT NOT NULL,to_column TEXT NOT NULL,from_done INTEGER NOT NULL,to_done INTEGER NOT NULL,created_at TEXT NOT NULL);`);
      const boardFields = this.db
        .prepare("PRAGMA table_info(boards)")
        .all() as { name: string }[];
      if (!boardFields.some((f) => f.name === "kind"))
        this.db.exec(
          "ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'kanban' CHECK(kind IN ('kanban','scrum'))",
        );
      if (!boardFields.some((f) => f.name === "parent_task_id"))
        this.db.exec(
          "ALTER TABLE boards ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT CHECK(parent_task_id IS NULL OR kind='scrum')",
        );
      this.db
        .exec(`CREATE UNIQUE INDEX IF NOT EXISTS board_master ON boards(parent_task_id) WHERE parent_task_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS sprints (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', start_date TEXT, end_date TEXT,
          status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','completed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          CHECK(start_date IS NULL OR end_date IS NULL OR start_date<=end_date));
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_sprint ON sprints(board_id) WHERE status='active';`);
      const taskFields = this.db.prepare("PRAGMA table_info(tasks)").all() as {
        name: string;
      }[];
      if (!taskFields.some((f) => f.name === "sprint_id"))
        this.db.exec(
          "ALTER TABLE tasks ADD COLUMN sprint_id TEXT REFERENCES sprints(id) ON DELETE RESTRICT",
        );
      this.db.exec(`CREATE INDEX IF NOT EXISTS tasks_sprint ON tasks(sprint_id);
        CREATE TRIGGER IF NOT EXISTS sprint_board_insert BEFORE INSERT ON tasks WHEN NEW.sprint_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM sprints s JOIN columns c ON c.board_id=s.board_id WHERE s.id=NEW.sprint_id AND c.id=NEW.column_id)
          BEGIN SELECT RAISE(ABORT,'sprint_board_mismatch'); END;
        CREATE TRIGGER IF NOT EXISTS sprint_board_update BEFORE UPDATE OF sprint_id,column_id ON tasks WHEN NEW.sprint_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM sprints s JOIN columns c ON c.board_id=s.board_id WHERE s.id=NEW.sprint_id AND c.id=NEW.column_id)
          BEGIN SELECT RAISE(ABORT,'sprint_board_mismatch'); END;`);
      // Existing cards get an honest migration marker, not invented old activity.
      if (old.length && !old.some((c) => c.name === "column_id")) {
        for (const t of this.list())
          this.insertPost(
            t.id,
            "event",
            "system",
            "Kortet flyttades över från den tidigare tavlan.",
          );
        this.bump();
      }
    })();
  }
  defaultBoardId(): string {
    return (
      this.db
        .prepare("SELECT id FROM boards ORDER BY created_at,rowid LIMIT 1")
        .get() as { id: string }
    ).id;
  }
  revision(): number {
    return (
      this.db.prepare("SELECT revision FROM metadata WHERE id=1").get() as {
        revision: number;
      }
    ).revision;
  }
  private bump() {
    this.db.prepare("UPDATE metadata SET revision=revision+1 WHERE id=1").run();
  }
  boards(): BoardInfo[] {
    return this.db
      .prepare(
        `SELECT b.*, (SELECT count(*) FROM tasks t JOIN columns c ON c.id=t.column_id WHERE c.board_id=b.id) AS task_count,
          (SELECT count(*) FROM tasks t JOIN columns c ON c.id=t.column_id WHERE c.board_id=b.id AND c.is_done=1) AS done_count,
          p.title AS parent_task_title,pc.board_id AS parent_board_id,pb.name AS parent_board_name,
          (SELECT name FROM sprints WHERE board_id=b.id AND status='active') AS active_sprint_name
          FROM boards b LEFT JOIN tasks p ON p.id=b.parent_task_id LEFT JOIN columns pc ON pc.id=p.column_id LEFT JOIN boards pb ON pb.id=pc.board_id ORDER BY b.created_at,b.rowid`,
      )
      .all() as BoardInfo[];
  }
  board(id: string): BoardInfo {
    const board = this.boards().find((b) => b.id === id);
    if (!board) throw new HttpError(404, "Tavlan finns inte.");
    return board;
  }
  columns(boardId: string): Column[] {
    this.boardExists(boardId);
    return (
      this.db
        .prepare("SELECT * FROM columns WHERE board_id=? ORDER BY position,id")
        .all(boardId) as (Omit<Column, "is_done"> & { is_done: number })[]
    ).map((c) => ({ ...c, is_done: !!c.is_done }));
  }
  private boardExists(id: string) {
    if (!this.db.prepare("SELECT id FROM boards WHERE id=?").get(id))
      throw new HttpError(404, "Tavlan finns inte.");
  }
  column(id: string): Column {
    const c = this.db.prepare("SELECT * FROM columns WHERE id=?").get(id) as
      | (Omit<Column, "is_done"> & { is_done: number })
      | undefined;
    if (!c) throw new HttpError(404, "Kolumnen finns inte.");
    return { ...c, is_done: !!c.is_done };
  }
  workspace(boardId = this.defaultBoardId()): Workspace {
    return {
      boards: this.boards(),
      board: this.board(boardId),
      columns: this.columns(boardId),
      tasks: this.list(boardId),
      revision: this.revision(),
      sprints: this.sprints(boardId),
    };
  }
  private insertBoard(value: z.output<typeof boardSchema>) {
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO boards (id,name,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, value.name, value.description, value.instructions, now, now);
    const template =
      value.kind === "scrum"
        ? [
            { key: "backlog", name: "Backlog" },
            { key: "todo", name: "Att göra" },
            { key: "in_progress", name: "Pågår" },
            { key: "review", name: "Granskning" },
            { key: "done", name: "Klart" },
          ]
        : [
            { key: "todo", name: "Att göra" },
            { key: "in_progress", name: "Pågår" },
            { key: "done", name: "Klart" },
          ];
    template.forEach((column, index) =>
      this.db
        .prepare(
          "INSERT INTO columns (id,board_id,key,name,is_done,position) VALUES (?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          id,
          column.key,
          column.name,
          column.key === "done" ? 1 : 0,
          index,
        ),
    );
    return id;
  }
  createBoard(input: z.input<typeof boardSchema>) {
    const value = boardSchema.parse(input);
    return this.db.transaction(() => {
      this.validateParent(value.parent_task_id, value.kind);
      const id = this.insertBoard(value);
      this.db
        .prepare("UPDATE boards SET kind=?,parent_task_id=? WHERE id=?")
        .run(value.kind, value.parent_task_id, id);
      if (value.parent_task_id)
        this.insertPost(
          value.parent_task_id,
          "event",
          "system",
          `Kopplade Scrum-tavlan ”${value.name}” till masterkortet.`,
        );
      this.bump();
      return this.board(id);
    })();
  }
  updateBoard(id: string, input: z.input<typeof boardEditSchema>) {
    const patch = boardEditSchema.parse(input);
    return this.db.transaction(() => {
      const next = {
        ...this.board(id),
        ...patch,
        updated_at: new Date().toISOString(),
      };
      this.validateParent(next.parent_task_id, next.kind, id);
      const previous = this.board(id).parent_task_id;
      this.db
        .prepare(
          "UPDATE boards SET name=@name,description=@description,instructions=@instructions,parent_task_id=@parent_task_id,updated_at=@updated_at WHERE id=@id",
        )
        .run(next);
      if (previous !== next.parent_task_id) {
        if (previous)
          this.insertPost(
            previous,
            "event",
            "system",
            `Frikopplade Scrum-tavlan ”${next.name}”.`,
          );
        if (next.parent_task_id)
          this.insertPost(
            next.parent_task_id,
            "event",
            "system",
            `Kopplade Scrum-tavlan ”${next.name}” till masterkortet.`,
          );
      }
      this.bump();
      return this.board(id);
    })();
  }
  createColumn(boardId: string, input: z.input<typeof columnSchema>) {
    const value = columnSchema.parse(input);
    return this.db.transaction(() => {
      const columns = this.columns(boardId),
        id = randomUUID();
      const index = Math.min(value.position ?? columns.length, columns.length);
      this.db
        .prepare(
          "INSERT INTO columns (id,board_id,key,name,description,is_done,position) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          id,
          boardId,
          id,
          value.name,
          value.description,
          value.is_done ? 1 : 0,
          index,
        );
      const ids = columns.map((c) => c.id);
      ids.splice(index, 0, id);
      this.orderColumns(ids);
      this.bump();
      return this.column(id);
    })();
  }
  private orderColumns(ids: string[]) {
    const stmt = this.db.prepare("UPDATE columns SET position=? WHERE id=?");
    ids.forEach((id, i) => stmt.run(i, id));
  }
  updateColumn(id: string, input: z.input<typeof columnEditSchema>) {
    const patch = columnEditSchema.parse(input);
    return this.db.transaction(() => {
      const old = this.column(id),
        next = { ...old, ...patch };
      this.db
        .prepare("UPDATE columns SET name=?,description=?,is_done=? WHERE id=?")
        .run(next.name, next.description, next.is_done ? 1 : 0, id);
      if (patch.position !== undefined) {
        const ids = this.columns(old.board_id)
          .filter((c) => c.id !== id)
          .map((c) => c.id);
        ids.splice(Math.min(patch.position, ids.length), 0, id);
        this.orderColumns(ids);
      }
      if (patch.name && patch.name !== old.name)
        for (const task of this.list(old.board_id).filter(
          (t) => t.column_id === id,
        ))
          this.insertPost(
            task.id,
            "event",
            "system",
            `Kolumnen bytte namn från ”${old.name}” till ”${next.name}”.`,
          );
      this.bump();
      return this.column(id);
    })();
  }
  list(boardId = this.defaultBoardId()): Task[] {
    this.boardExists(boardId);
    return (
      this.db
        .prepare(
          taskSelect +
            " WHERE c.board_id=? ORDER BY c.position,t.position,t.id",
        )
        .all(boardId) as Task[]
    ).map((task) => this.hydrateTask(task));
  }
  get(id: string): Task {
    const task = this.db.prepare(taskSelect + " WHERE t.id=?").get(id) as
      | Task
      | undefined;
    if (!task) throw new HttpError(404, "Uppgiften finns inte längre.");
    return this.hydrateTask(task);
  }
  detail(id: string, before?: number, limit = 30): TaskDetail {
    const task = this.get(id);
    const posts = this.db
      .prepare(
        "SELECT * FROM posts WHERE task_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
      )
      .all(id, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as Post[];
    const hasMore = posts.length > limit;
    if (hasMore) posts.pop();
    return {
      task,
      posts,
      next_before: hasMore ? posts[posts.length - 1].seq : null,
    };
  }
  post(id: string): Post {
    const post = this.db.prepare("SELECT * FROM posts WHERE id=?").get(id) as
      | Post
      | undefined;
    if (!post) throw new HttpError(404, "Inlägget finns inte.");
    return post;
  }
  search(
    query: string,
    boardId: string | undefined,
    offset: number,
    limit: number,
  ) {
    if (boardId) this.boardExists(boardId);
    const match = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const filter = ` WHERE (t.title LIKE @query ESCAPE '\\' OR t.description LIKE @query ESCAPE '\\' OR EXISTS (SELECT 1 FROM posts p WHERE p.task_id=t.id AND p.content LIKE @query ESCAPE '\\'))${boardId ? " AND c.board_id=@board" : ""}`;
    const params = { query: match, ...(boardId ? { board: boardId } : {}) };
    const total = (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM tasks t JOIN columns c ON c.id=t.column_id" +
            filter,
        )
        .get(params) as { n: number }
    ).n;
    const tasks = this.db
      .prepare(
        taskSelect +
          filter +
          " ORDER BY t.updated_at DESC,t.id LIMIT @limit OFFSET @offset",
      )
      .all({ ...params, limit, offset }) as Task[];
    return {
      tasks: tasks.map((task) => this.hydrateTask(task)),
      total,
      next_offset: offset + tasks.length < total ? offset + tasks.length : null,
    };
  }
  private resolveColumn(
    input: { column_id?: string; board_id?: string; status?: string },
    fallbackBoard: string,
    fallbackColumn?: string,
  ) {
    const boardId = input.board_id ?? fallbackBoard;
    if (input.column_id) {
      const column = this.column(input.column_id);
      if (input.board_id && column.board_id !== input.board_id)
        throw new HttpError(400, "Kolumnen tillhör en annan tavla.");
      if (input.status && column.key !== input.status)
        throw new HttpError(400, "Status och kolumn stämmer inte överens.");
      return column;
    }
    const columns = this.columns(boardId);
    const column = input.status
      ? columns.find((c) => c.key === input.status)
      : fallbackColumn && !input.board_id
        ? columns.find((c) => c.id === fallbackColumn)
        : columns[0];
    if (!column)
      throw new HttpError(400, "Tavlan saknar den angivna kolumnen.");
    return column;
  }
  private order(columnId: string, ids: string[]) {
    const stmt = this.db.prepare(
      "UPDATE tasks SET position=?,updated_at=? WHERE id=? AND column_id=? AND position!=?",
    );
    const now = new Date().toISOString();
    ids.forEach((id, i) => stmt.run(i, now, id, columnId, i));
  }
  private insertPost(
    taskId: string,
    kind: Post["kind"],
    author: Author,
    content: string,
  ) {
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO posts (id,task_id,kind,author,content,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, taskId, kind, author, content, now);
    return this.db.prepare("SELECT * FROM posts WHERE id=?").get(id) as Post;
  }
  create(input: NewTask, author: Author = "user"): Task {
    const value = createSchema.parse(input);
    return this.db.transaction(() => {
      let column = this.resolveColumn(value, this.defaultBoardId());
      const sprintId = value.sprint_id ?? null;
      this.validateSprint(sprintId, column.board_id);
      if (sprintId && column.key === "backlog")
        column =
          this.columns(column.board_id).find((c) => c.key === "todo") ?? column;
      const position = (
        this.db
          .prepare("SELECT count(*) AS n FROM tasks WHERE column_id=?")
          .get(column.id) as { n: number }
      ).n;
      const id = randomUUID(),
        now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO tasks (id,column_id,title,description,priority,due_date,position,created_at,updated_at,sprint_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          column.id,
          value.title,
          value.description ?? "",
          value.priority ?? "normal",
          value.due_date ?? null,
          position,
          now,
          now,
          sprintId,
        );
      this.insertPost(
        id,
        "event",
        author,
        `Skapade kortet i ”${column.name}”.`,
      );
      if (sprintId)
        this.insertPost(
          id,
          "event",
          author,
          `Planerade kortet i ”${this.sprint(sprintId).name}”.`,
        );
      this.touchParent(column.board_id);
      this.bump();
      return this.get(id);
    })();
  }
  createMany(inputs: NewTask[], author: Author = "assistant") {
    return this.db.transaction(() =>
      inputs.map((input) => this.create(input, author)),
    )();
  }
  update(id: string, input: TaskPatch, author: Author = "user"): Task {
    const patch = editSchema.parse(input);
    return this.db.transaction(() => {
      const old = this.get(id);
      let column = this.resolveColumn(patch, old.board_id, old.column_id);
      if (old.child_board && this.board(column.board_id).kind !== "kanban")
        throw new HttpError(
          409,
          "Ett masterkort med en Scrum-tavla måste ligga kvar på en Kanban-tavla.",
        );
      let sprintId =
        patch.sprint_id === undefined
          ? column.board_id === old.board_id
            ? old.sprint_id
            : null
          : patch.sprint_id;
      if (
        column.key === "backlog" &&
        patch.sprint_id === undefined &&
        column.id !== old.column_id
      )
        sprintId = null;
      if (
        sprintId &&
        (sprintId !== old.sprint_id || column.board_id !== old.board_id)
      )
        this.validateSprint(sprintId, column.board_id);
      if (sprintId && column.key === "backlog")
        column =
          this.columns(column.board_id).find((c) => c.key === "todo") ?? column;
      if (
        patch.sprint_id === null &&
        this.board(column.board_id).kind === "scrum" &&
        patch.column_id === undefined &&
        patch.status === undefined
      )
        column =
          this.columns(column.board_id).find((c) => c.key === "backlog") ??
          column;
      const next = {
        ...old,
        ...patch,
        column_id: column.id,
        sprint_id: sprintId,
        updated_at: new Date().toISOString(),
      };
      const moving =
        patch.position !== undefined || column.id !== old.column_id;
      if (moving) {
        const ids = (
          this.db
            .prepare(
              "SELECT id FROM tasks WHERE column_id=? AND id!=? ORDER BY position,id",
            )
            .all(column.id, id) as { id: string }[]
        ).map((t) => t.id);
        const index = Math.min(
          patch.position ??
            (column.id === old.column_id ? old.position : ids.length),
          ids.length,
        );
        ids.splice(index, 0, id);
        this.db
          .prepare("UPDATE tasks SET column_id=?,sprint_id=? WHERE id=?")
          .run(column.id, sprintId, id);
        this.order(column.id, ids);
        if (column.id !== old.column_id)
          this.order(
            old.column_id,
            (
              this.db
                .prepare(
                  "SELECT id FROM tasks WHERE column_id=? ORDER BY position,id",
                )
                .all(old.column_id) as { id: string }[]
            ).map((t) => t.id),
          );
        next.position = index;
      }
      this.db
        .prepare(
          "UPDATE tasks SET title=@title,description=@description,column_id=@column_id,priority=@priority,due_date=@due_date,position=@position,sprint_id=@sprint_id,updated_at=@updated_at WHERE id=@id",
        )
        .run(next);
      if (column.id !== old.column_id)
        this.db
          .prepare(
            "INSERT INTO task_transitions(task_id,title,from_column,to_column,from_done,to_done,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id,
            next.title,
            old.column_id,
            column.id,
            this.column(old.column_id).is_done ? 1 : 0,
            column.is_done && column.key !== "rejected" ? 1 : 0,
            next.updated_at,
          );
      if (column.id !== old.column_id)
        this.insertPost(
          id,
          "event",
          author,
          `Flyttade från ”${this.column(old.column_id).name}” (${this.board(old.board_id).name}) till ”${column.name}” (${this.board(column.board_id).name}).`,
        );
      const changed = (
        ["title", "description", "priority", "due_date"] as const
      ).filter((key) => old[key] !== next[key]);
      if (changed.length)
        this.insertPost(
          id,
          "event",
          author,
          `Uppdaterade ${changed.map((key) => ({ title: "titeln", description: "beskrivningen", priority: "prioriteten", due_date: "deadline" })[key]).join(", ")}.`,
        );
      if (
        moving &&
        old.column_id === column.id &&
        old.position !== next.position
      )
        this.insertPost(id, "event", author, "Ändrade ordning i kolumnen.");
      if (old.sprint_id !== sprintId)
        this.insertPost(
          id,
          "event",
          author,
          sprintId
            ? `Planerade kortet i ”${this.sprint(sprintId).name}”.`
            : "Återförde kortet till backlog utan sprint.",
        );
      this.touchParent(old.board_id);
      this.touchParent(column.board_id);
      this.bump();
      return this.get(id);
    })();
  }
  addPost(
    id: string,
    input: z.input<typeof postSchema>,
    author: "user" | "assistant" = "user",
  ) {
    const value = postSchema.parse(input);
    return this.db.transaction(() => {
      this.get(id);
      const post = this.insertPost(id, value.kind, author, value.content);
      this.db
        .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
        .run(post.created_at, id);
      this.bump();
      return post;
    })();
  }
  delete(id: string) {
    this.db.transaction(() => {
      const task = this.get(id);
      this.ensureDeletable(id);
      this.db.prepare("DELETE FROM tasks WHERE id=?").run(id);
      this.order(
        task.column_id,
        (
          this.db
            .prepare(
              "SELECT id FROM tasks WHERE column_id=? ORDER BY position,id",
            )
            .all(task.column_id) as { id: string }[]
        ).map((t) => t.id),
      );
      this.touchParent(task.board_id);
      this.bump();
    })();
  }
  private hydrateTask(task: Task): Task {
    return { ...task, child_board: this.childBoard(task.id) };
  }
  childBoard(taskId: string): ChildBoard | null {
    const board = this.boards().find(
      (board) => board.parent_task_id === taskId,
    );
    return board
      ? {
          id: board.id,
          name: board.name,
          task_count: board.task_count,
          done_count: board.done_count,
          active_sprint_name: board.active_sprint_name,
        }
      : null;
  }
  private validateParent(
    parentId: string | null,
    kind: BoardInfo["kind"],
    boardId?: string,
  ) {
    if (!parentId) return;
    if (kind !== "scrum")
      throw new HttpError(
        400,
        "Endast Scrum-tavlor kan kopplas till masterkort.",
      );
    const parent = this.get(parentId);
    if (
      parent.board_id === boardId ||
      this.board(parent.board_id).kind !== "kanban"
    )
      throw new HttpError(
        400,
        "Masterkortet måste ligga på en annan Kanban-tavla.",
      );
    const existing = this.childBoard(parentId);
    if (existing && existing.id !== boardId)
      throw new HttpError(409, "Masterkortet har redan en Scrum-tavla.");
  }
  ensureDeletable(id: string) {
    if (this.childBoard(id))
      throw new HttpError(
        409,
        "Kortet har en kopplad Scrum-tavla. Frikoppla tavlan innan du tar bort masterkortet.",
      );
  }
  private touchParent(boardId: string) {
    this.db
      .prepare(
        "UPDATE tasks SET updated_at=? WHERE id=(SELECT parent_task_id FROM boards WHERE id=?)",
      )
      .run(new Date().toISOString(), boardId);
  }
  private sprintSelect = `SELECT s.*, (SELECT count(*) FROM tasks t WHERE t.sprint_id=s.id) AS task_count,
    (SELECT count(*) FROM tasks t JOIN columns c ON c.id=t.column_id WHERE t.sprint_id=s.id AND c.is_done=1) AS done_count FROM sprints s`;
  sprints(boardId: string): Sprint[] {
    return this.db
      .prepare(
        this.sprintSelect + " WHERE s.board_id=? ORDER BY s.created_at,s.rowid",
      )
      .all(boardId) as Sprint[];
  }
  sprint(id: string): Sprint {
    const sprint = this.db
      .prepare(this.sprintSelect + " WHERE s.id=?")
      .get(id) as Sprint | undefined;
    if (!sprint) throw new HttpError(404, "Sprinten finns inte.");
    return sprint;
  }
  private validateSprint(id: string | null, boardId: string) {
    if (!id) return;
    const sprint = this.sprint(id);
    if (sprint.board_id !== boardId)
      throw new HttpError(400, "Sprinten tillhör en annan tavla.");
    if (sprint.status === "completed")
      throw new HttpError(
        409,
        "Sprinten är avslutad. Välj en planerad eller aktiv sprint.",
      );
  }
  createSprint(
    boardId: string,
    input: z.input<typeof sprintSchema>,
    author: Author = "user",
  ) {
    const value = sprintSchema.parse(input);
    return this.db.transaction(() => {
      if (this.board(boardId).kind !== "scrum")
        throw new HttpError(400, "Sprintar hör till Scrum-tavlor.");
      const id = randomUUID(),
        now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO sprints (id,board_id,name,goal,start_date,end_date,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'planned',?,?)",
        )
        .run(
          id,
          boardId,
          value.name,
          value.goal,
          value.start_date,
          value.end_date,
          now,
          now,
        );
      this.touchParent(boardId);
      this.bump();
      return this.sprint(id);
    })();
  }
  updateSprint(id: string, input: z.input<typeof sprintEditSchema>) {
    const patch = sprintEditSchema.parse(input);
    return this.db.transaction(() => {
      const next = {
        ...this.sprint(id),
        ...patch,
        updated_at: new Date().toISOString(),
      };
      if (next.start_date && next.end_date && next.start_date > next.end_date)
        throw new HttpError(400, "Slutdatum måste vara efter startdatum.");
      this.db
        .prepare(
          "UPDATE sprints SET name=@name,goal=@goal,start_date=@start_date,end_date=@end_date,updated_at=@updated_at WHERE id=@id",
        )
        .run(next);
      this.touchParent(next.board_id);
      this.bump();
      return this.sprint(id);
    })();
  }
  transitionSprint(
    id: string,
    state: "active" | "completed",
    author: Author = "user",
  ) {
    return this.db.transaction(() => {
      const sprint = this.sprint(id);
      if (state === "active" && sprint.status !== "planned")
        throw new HttpError(409, "Endast en planerad sprint kan startas.");
      if (state === "completed" && sprint.status !== "active")
        throw new HttpError(409, "Endast en aktiv sprint kan avslutas.");
      if (
        state === "active" &&
        this.sprints(sprint.board_id).some((s) => s.status === "active")
      )
        throw new HttpError(
          409,
          "Tavlan har redan en aktiv sprint. Avsluta den först.",
        );
      this.db
        .prepare("UPDATE sprints SET status=?,updated_at=? WHERE id=?")
        .run(state, new Date().toISOString(), id);
      const parent = this.board(sprint.board_id).parent_task_id;
      if (parent)
        this.insertPost(
          parent,
          "event",
          author,
          `${state === "active" ? "Startade" : "Avslutade"} ”${sprint.name}” på Scrum-tavlan. ${sprint.done_count} av ${sprint.task_count} kort klara.`,
        );
      this.touchParent(sprint.board_id);
      this.bump();
      return this.sprint(id);
    })();
  }
  assignSprint(
    taskIds: string[],
    sprintId: string | null,
    author: Author = "user",
  ) {
    return this.db.transaction(() => {
      // Validate the entire batch before the first write. update() also validates each move.
      for (const id of taskIds) {
        const task = this.get(id);
        if (this.board(task.board_id).kind !== "scrum")
          throw new HttpError(
            400,
            "Endast kort på en Scrum-tavla kan planeras i sprintar.",
          );
        this.validateSprint(sprintId, task.board_id);
      }
      return taskIds.map((id) =>
        this.update(id, { sprint_id: sprintId }, author),
      );
    })();
  }
  ensureBoardDeletable(id: string) {
    this.board(id);
    const linked = this.boards().filter((b) => b.parent_board_id === id);
    if (linked.length)
      throw new HttpError(
        409,
        "Tavlan innehåller masterkort med kopplade Scrum-tavlor. Frikoppla Scrum-tavlorna först: " +
          linked.map((b) => b.name).join(", "),
      );
  }
  deleteBoard(id: string) {
    return this.db.transaction(() => {
      this.ensureBoardDeletable(id);
      const board = this.board(id);
      if (board.parent_task_id)
        this.insertPost(
          board.parent_task_id,
          "event",
          "user",
          `Tog bort Scrum-tavlan ”${board.name}” efter bekräftelse.`,
        );
      this.db
        .prepare(
          "DELETE FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE board_id=?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM sprints WHERE board_id=?").run(id);
      this.db.prepare("DELETE FROM columns WHERE board_id=?").run(id);
      this.db.prepare("DELETE FROM boards WHERE id=?").run(id);
      if (!this.boards().length) this.createBoard({ name: "Min tavla" });
      this.bump();
      return this.workspace();
    })();
  }
  close() {
    this.db.close();
  }
}
