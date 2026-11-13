import { z } from "zod";

export const calendarId = z.string().min(1).max(2000);
export const calendarRange = z
  .object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((x) => {
    const duration = Date.parse(x.end) - Date.parse(x.start);
    return duration > 0 && duration <= 93 * 86400000;
  }, "Välj ett intervall på högst 93 dagar med slut efter start.");
const fields = {
  title: z.string().trim().min(1).max(250),
  description: z.string().max(10000).default(""),
  location: z.string().max(500).default(""),
};
export const calendarDraft = z
  .discriminatedUnion("all_day", [
    z
      .object({
        ...fields,
        all_day: z.literal(false),
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
      })
      .strict(),
    z
      .object({
        ...fields,
        all_day: z.literal(true),
        start: z.iso.date(),
        end: z.iso.date(),
      })
      .strict(),
  ])
  .refine(
    (x) => Date.parse(x.end) > Date.parse(x.start),
    "Slutet måste vara efter starten. För heldag är slutdatumet första dagen efter händelsen.",
  );
export type CalendarDraft = z.infer<typeof calendarDraft>;
export type CalendarEvent = CalendarDraft & {
  id: string;
  account_id: string;
  version: string;
  read_only: boolean;
  recurring: boolean;
  organizer: string;
  attendees: string[];
  url: string | null;
};
export const accountInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("online"),
      name: z.string().trim().min(1).max(80),
      allow_ai: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("onprem"),
      name: z.string().trim().min(1).max(80),
      endpoint: z
        .url()
        .max(1000)
        .refine((value) => {
          const u = new URL(value);
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash &&
            /\/ews\/exchange\.asmx$/i.test(u.pathname)
          );
        }, "Ange en HTTPS-adress till /EWS/Exchange.asmx utan användaruppgifter eller parametrar."),
      username: z
        .string()
        .trim()
        .min(1)
        .max(250)
        .regex(/^[^\r\n:\x00]+$/),
      password: z
        .string()
        .min(1)
        .max(1000)
        .regex(/^[^\r\n\x00]+$/),
      auth: z.enum(["ntlm", "basic"]).default("ntlm"),
      allow_ai: z.boolean().default(true),
    })
    .strict(),
]);
export type CalendarAccountInput = z.infer<typeof accountInput>;
export type CalendarAccount = {
  id: string;
  name: string;
  kind: "online" | "onprem";
  allow_ai: boolean;
  connected: boolean;
  error?: string;
};
export type CalendarResult = {
  events: CalendarEvent[];
  errors: { account_id: string; message: string }[];
  truncated: boolean;
  fetched_at: string;
};
