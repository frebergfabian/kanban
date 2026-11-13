import { z } from "zod";

export const mailSearch = z
  .object({
    account_id: z.uuid(),
    query: z.string().trim().max(200).default(""),
    folder: z.enum(["inbox", "sent"]).default("inbox"),
    offset: z.number().int().min(0).max(1000).default(0),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type MailSearch = z.infer<typeof mailSearch>;
export type MailAddress = { name: string; address: string };
export type MailMessage = {
  id: string;
  account_id: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  received_at: string;
  preview: string;
  is_read: boolean;
  has_attachments: boolean;
  conversation_id: string | null;
  url: string | null;
};
export type MailDetail = MailMessage & {
  body: string;
  body_truncated: boolean;
};
export type MailPage = {
  messages: MailMessage[];
  next_offset: number | null;
  fetched_at: string;
};
