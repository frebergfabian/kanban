import { z } from "zod";
import { calendarId, calendarRange } from "./calendar.js";

export const statuses = ["todo", "in_progress", "done"] as const;
export const labels = { todo: "Att göra", in_progress: "Pågår", done: "Klart" };
export const priorities = { low: "Låg", normal: "Normal", high: "Hög" };
export const statusSchema = z.enum(statuses);
export const idSchema = z.string().uuid();
const title = z.string().trim().min(1, "Titel krävs.").max(200);
const description = z.string().max(10000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Ange ÅÅÅÅ-MM-DD.")
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`);
    return (
      !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    );
  }, "Datumet finns inte.");
const priority = z.enum(["low", "normal", "high"]);
const position = z.number().int().min(0).max(100000);
const notEmpty = (value: object) => Object.keys(value).length > 0;
const taskFields = {
  title,
  description: description.optional(),
  priority: priority.optional(),
  due_date: date.nullable().optional(),
};
export const createSchema = z
  .object({
    ...taskFields,
    board_id: idSchema.optional(),
    column_id: idSchema.optional(),
    status: statusSchema.optional(),
    sprint_id: idSchema.nullable().optional(),
  })
  .strict();
export const editSchema = z
  .object({
    title: title.optional(),
    description: description.optional(),
    priority: priority.optional(),
    due_date: date.nullable().optional(),
    board_id: idSchema.optional(),
    column_id: idSchema.optional(),
    status: statusSchema.optional(),
    position: position.optional(),
    sprint_id: idSchema.nullable().optional(),
  })
  .strict()
  .refine(notEmpty, "Inga ändringar angavs.");
export const boardSchema = z
  .object({
    name: title,
    description: description.default(""),
    instructions: description.default(""),
    kind: z.enum(["kanban", "scrum"]).default("kanban"),
    parent_task_id: idSchema.nullable().default(null),
  })
  .strict();
export const boardEditSchema = z
  .object({
    name: title.optional(),
    description: description.optional(),
    instructions: description.optional(),
    parent_task_id: idSchema.nullable().optional(),
  })
  .strict()
  .refine(notEmpty, "Inga ändringar angavs.");
export const columnSchema = z
  .object({
    name: title,
    description: z.string().max(2000).default(""),
    is_done: z.boolean().default(false),
    position: position.optional(),
  })
  .strict();
export const columnEditSchema = z
  .object({
    name: title.optional(),
    description: z.string().max(2000).optional(),
    is_done: z.boolean().optional(),
    position: position.optional(),
  })
  .strict()
  .refine(notEmpty, "Inga ändringar angavs.");
export const postSchema = z
  .object({
    content: z.string().trim().min(1, "Skriv ett inlägg.").max(10000),
    kind: z.enum(["note", "update"]).default("update"),
  })
  .strict();
export const sprintSchema = z
  .object({
    name: title,
    goal: description.default(""),
    start_date: date.nullable().default(null),
    end_date: date.nullable().default(null),
  })
  .strict()
  .refine(
    (v) => !v.start_date || !v.end_date || v.start_date <= v.end_date,
    "Slutdatum måste vara efter startdatum.",
  );
export const sprintEditSchema = z
  .object({
    name: title.optional(),
    goal: description.optional(),
    start_date: date.nullable().optional(),
    end_date: date.nullable().optional(),
  })
  .strict()
  .refine(notEmpty, "Inga ändringar angavs.");
const page = {
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(60).default(30),
};
export const toolSchemas = {
  list_calendar_accounts: z.object({}).strict(),
  list_calendar_events: calendarRange.safeExtend({
    account_id: z.uuid().optional(),
    query: z.string().max(200).default(""),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(30),
  }),
  get_calendar_event: z
    .object({ account_id: z.uuid(), event_id: calendarId })
    .strict(),
  search_memory: z
    .object({
      query: z.string().max(200).default(""),
      board_id: idSchema.optional(),
      all_boards: z.boolean().default(false),
    })
    .strict(),
  save_memory: z
    .object({
      key: z.string().trim().min(1).max(120),
      content: z.string().trim().min(1).max(2000),
      kind: z.enum(["preference", "fact", "decision"]).default("fact"),
      scope: z.enum(["board", "global"]).default("board"),
      source_message_id: idSchema,
    })
    .strict(),
  forget_memory: z.object({ id: idSchema }).strict(),
  search_conversations: z
    .object({
      query: z.string().max(200).default(""),
      board_id: idSchema.optional(),
      all_boards: z.boolean().default(false),
      ...page,
    })
    .strict(),
  get_conversation: z.object({ id: idSchema, ...page }).strict(),
  get_job: z.object({ id: idSchema }).strict(),
  get_logs: z
    .object({
      job_id: idSchema.optional(),
      level: z.enum(["info", "warn", "error"]).optional(),
      query: z.string().max(200).default(""),
      ...page,
    })
    .strict(),
  get_board_report: z.object({ board_id: idSchema.optional() }).strict(),
  request_delete_board: z.object({ board_id: idSchema }).strict(),
  get_help: z.object({}).strict(),
  list_boards: z.object({}).strict(),
  get_board: z.object({ board_id: idSchema.optional(), ...page }).strict(),
  create_board: boardSchema
    .extend({
      tasks: z.array(z.object(taskFields).strict()).max(20).optional(),
    })
    .strict(),
  create_scrum_board: z
    .object({
      name: title,
      description: description.default(""),
      instructions: description.default(""),
      parent_task_id: idSchema.nullable().optional(),
      tasks: z.array(z.object(taskFields).strict()).max(20).optional(),
    })
    .strict(),
  create_sprint: z
    .object({ board_id: idSchema.optional(), ...sprintSchema.shape })
    .strict()
    .refine(
      (v) => !v.start_date || !v.end_date || v.start_date <= v.end_date,
      "Slutdatum måste vara efter startdatum.",
    ),
  update_sprint: z.object({ id: idSchema, fields: sprintEditSchema }).strict(),
  start_sprint: z.object({ id: idSchema }).strict(),
  complete_sprint: z.object({ id: idSchema }).strict(),
  assign_to_sprint: z
    .object({
      task_ids: z
        .array(idSchema)
        .min(1)
        .max(20)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Kort-ID får inte upprepas.",
        ),
      sprint_id: idSchema.nullable(),
    })
    .strict(),
  update_board: z
    .object({ board_id: idSchema, fields: boardEditSchema })
    .strict(),
  create_column: z
    .object({ board_id: idSchema.optional(), ...columnSchema.shape })
    .strict(),
  update_column: z
    .object({ column_id: idSchema, fields: columnEditSchema })
    .strict(),
  get_post: z.object({ id: idSchema }).strict(),
  get_task: z
    .object({ id: idSchema, before: z.number().int().positive().optional() })
    .strict(),
  search_tasks: z
    .object({
      query: z.string().trim().min(1).max(200),
      board_id: idSchema.optional(),
      all_boards: z.boolean().default(false),
      ...page,
    })
    .strict(),
  create_task: createSchema,
  create_tasks: z
    .object({
      board_id: idSchema.optional(),
      column_id: idSchema.optional(),
      sprint_id: idSchema.nullable().optional(),
      tasks: z.array(z.object(taskFields).strict()).min(1).max(20),
    })
    .strict(),
  update_task: z
    .object({
      id: idSchema,
      fields: z
        .object({
          title: title.optional(),
          description: description.optional(),
          priority: priority.optional(),
          due_date: date.nullable().optional(),
        })
        .strict()
        .refine(notEmpty, "Inga ändringar angavs."),
    })
    .strict(),
  move_task: z
    .object({
      id: idSchema,
      column_id: idSchema.optional(),
      board_id: idSchema.optional(),
      status: statusSchema.optional(),
      position: position.optional(),
    })
    .strict()
    .refine(
      (v) => v.column_id !== undefined || v.status !== undefined,
      "Ange column_id.",
    ),
  add_post: z.object({ id: idSchema, ...postSchema.shape }).strict(),
  request_delete_task: z.object({ id: idSchema }).strict(),
};
export type Status = (typeof statuses)[number];
export type NewTask = z.input<typeof createSchema>;
export type TaskPatch = z.infer<typeof editSchema>;
export type BoardInfo = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  created_at: string;
  updated_at: string;
  task_count: number;
  done_count: number;
  kind: "kanban" | "scrum";
  parent_task_id: string | null;
  parent_task_title: string | null;
  parent_board_id: string | null;
  parent_board_name: string | null;
  active_sprint_name: string | null;
};
export type Sprint = {
  id: string;
  board_id: string;
  name: string;
  goal: string;
  start_date: string | null;
  end_date: string | null;
  status: "planned" | "active" | "completed";
  created_at: string;
  updated_at: string;
  task_count: number;
  done_count: number;
};
export type ChildBoard = {
  id: string;
  name: string;
  task_count: number;
  done_count: number;
  active_sprint_name: string | null;
};
export type Column = {
  id: string;
  board_id: string;
  key: string;
  name: string;
  description: string;
  is_done: boolean;
  position: number;
};
export type Task = {
  id: string;
  board_id: string;
  column_id: string;
  status: string;
  title: string;
  description: string;
  priority: "low" | "normal" | "high";
  due_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  post_count: number;
  latest_post: string | null;
  sprint_id: string | null;
  child_board: ChildBoard | null;
};
export type Post = {
  seq: number;
  id: string;
  task_id: string;
  kind: "note" | "update" | "event";
  author: "user" | "assistant" | "system";
  content: string;
  created_at: string;
};
export type TaskDetail = {
  task: Task;
  posts: Post[];
  next_before: number | null;
};
export type Workspace = {
  boards: BoardInfo[];
  board: BoardInfo;
  columns: Column[];
  tasks: Task[];
  revision: number;
  sprints: Sprint[];
};
export type PendingDeletion = { request_id: string; task: Task };
export type ChatEvent =
  | { type: "board"; tasks: Task[]; workspace?: Workspace }
  | { type: "deletion"; deletion: PendingDeletion }
  | {
      type: "done";
      message: string;
      error?: string;
      receipts?: string[];
      awaiting_input?: boolean;
    }
  | { type: "receipt"; message: string }
  | { type: "progress"; message: string }
  | { type: "error"; message: string };
export type AiStatus = { available: boolean; model: string; message: string };
export type ChatContext = {
  board_id?: string;
  task_id?: string;
  sprint_id?: string | null;
};

export type JobStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type AiJob = {
  id: string;
  conversation_id: string;
  board_id: string;
  task_id: string | null;
  sprint_id: string | null;
  message: string;
  status: JobStatus;
  stage: string;
  position: number;
  progress: string;
  result: string;
  error: string | null;
  receipts: string[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  dismissed: number;
};
export type Conversation = {
  id: string;
  title: string;
  board_id: string | null;
  created_at: string;
  updated_at: string;
  summary: string;
};
export type ChatMessage = {
  id: string;
  conversation_id: string;
  job_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};
export type Memory = {
  id: string;
  key: string;
  content: string;
  kind: string;
  board_id: string | null;
  source_message_id: string | null;
  source: string;
  uses: number;
  created_at: string;
  updated_at: string;
};
export type AuditLog = {
  id: number;
  job_id: string | null;
  level: "info" | "warn" | "error";
  event: string;
  detail: string;
  created_at: string;
};
export type Confirmation = {
  id: string;
  kind: "task" | "board";
  target_id: string;
  name: string;
  snapshot: string;
  job_id: string | null;
  conversation_id: string | null;
  status: string;
  created_at: string;
};
export type AiWork = {
  jobs: AiJob[];
  conversations: Conversation[];
  pending: Confirmation[];
  revision: number;
};
