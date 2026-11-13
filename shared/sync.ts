import { z } from "zod";

export const categories = [
  "action",
  "question",
  "meeting",
  "information",
  "newsletter",
  "spam",
] as const;
export const analysisSchema = z
  .object({
    category: z.enum(categories),
    urgency: z.number().int().min(0).max(100),
    action_required: z.boolean(),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(1600),
    action_title: z.string().max(200),
    action_details: z.string().max(4000),
    due_date: z.iso.date().nullable(),
    evidence: z.string().max(800),
    match_task_id: z.uuid().nullable(),
    match_confidence: z.number().min(0).max(1),
  })
  .strict();
export type SourceAnalysis = z.infer<typeof analysisSchema>;
// Ollama's grammar compiler does not support Zod's full date/UUID regexes.
// Generation uses strings; the strict schema above validates the result before any write.
export const analysisFormat = z.toJSONSchema(
  analysisSchema.omit({ evidence: true }).extend({
    evidence_id: z.string().nullable(),
    due_date: z.string().nullable(),
    match_task_id: z.string().nullable(),
  }),
);
export type SyncFolder = {
  id: string;
  name: string;
  kind: "mail" | "calendar";
  role: "incoming" | "sent" | "drafts" | "junk" | "deleted";
  owner?: string;
};
export type SyncDocument = {
  kind: "mail" | "calendar";
  external_id: string;
  identity: string;
  thread_id: string | null;
  title: string;
  body: string;
  body_truncated: boolean;
  occurred_at: string;
  sender: string;
  recipients: string[];
  owner: string;
  folder: string;
  role: SyncFolder["role"];
  url: string | null;
  starts_at: string | null;
  ends_at: string | null;
  cancelled: boolean;
};
export type SyncPage = {
  documents: SyncDocument[];
  removed: string[];
  cursor: string | null;
  complete: boolean;
};
export const syncSettings = z
  .object({
    enabled: z.boolean(),
    board_id: z.uuid(),
    initial_days: z.number().int().min(1).max(365).default(30),
    interval_seconds: z.number().int().min(60).max(3600).default(300),
    calendar_future_days: z.number().int().min(1).max(365).default(90),
    account_ids: z.array(z.uuid()).max(8),
  })
  .strict();
export type SyncSettings = z.infer<typeof syncSettings> & { since: string };
export const analysisRequest = z
  .object({
    account_ids: z.array(z.uuid()).min(1).max(8).optional(),
    kind: z.enum(["mail", "calendar", "all"]).default("mail"),
    limit: z.number().int().min(1).max(10000).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((x) => !!x.limit || !!x.from, "Ange antal eller ett datumintervall.")
  .refine(
    (x) => !x.from || !x.to || Date.parse(x.from) < Date.parse(x.to),
    "Slutdatum måste vara efter startdatum.",
  );
export type AnalysisRequest = z.infer<typeof analysisRequest>;
export const indexSearch = z
  .object({
    query: z.string().trim().max(200).default(""),
    kind: z.enum(["mail", "calendar", "all"]).default("all"),
    account_id: z.uuid().optional(),
    category: z.enum(categories).optional(),
    min_urgency: z.number().int().min(0).max(100).default(0),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    offset: z.number().int().min(0).max(1000000).default(0),
    limit: z.number().int().min(1).max(50).default(25),
  })
  .strict();
