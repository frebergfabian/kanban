import { z } from "zod";
import type { SyncDocument } from "./sync.js";

export const ignoredSender = z
  .object({
    sender: z.email().max(320),
    reason: z.string().trim().max(500).default(""),
  })
  .strict();
export const rejectCard = z
  .object({ id: z.uuid(), reason: z.string().trim().min(1).max(1000) })
  .strict();
export const waitingCard = z
  .object({
    id: z.uuid(),
    reason: z.string().trim().min(1).max(1000),
    until: z.iso.date().nullable().default(null),
  })
  .strict();
export function senderAddress(value: string) {
  return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
}
/** Attendance and routine calendar entries are never sufficient evidence of work. */
export function calendarNeedsPreparation(doc: SyncDocument, now = Date.now()) {
  if (doc.kind !== "calendar") return true;
  if (doc.cancelled || (doc.ends_at && Date.parse(doc.ends_at) < now))
    return false;
  if (
    /\b(jul(?:dagen|afton)|annandag(?: jul| påsk)?|nyårs(?:dagen|afton)|midsommar(?:dagen|afton)?|nationaldag(?:en)?|trettondedag(?: jul)?|kristi himmelsfärd|första maj|alla helgons dag|pingst(?:dagen|afton)?|långfredag(?:en)?|påsk(?:dagen|afton)|röd dag|helgdag|födelsedag|semester|frånvaro|ledig|holiday|birthday|out of office|vacation)\b/iu.test(
      doc.title,
    )
  )
    return false;
  return /\b(förbered\p{L}*|förarbete|läs igenom|ta fram|sammanställ\p{L}*|skicka (?:in |ett |en |ditt |din )?(?:underlag|rapport|presentation)|prepare\p{L}*|preparation|pre[- ]?read|review (?:the |this )?(?:document|agenda|material)|bring (?:your |a )?(?:report|presentation))\b/iu.test(
    `${doc.title}\n${doc.body}`,
  );
}
