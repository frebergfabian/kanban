import { z } from "zod";

export const microsoftScopes = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Calendars.Read",
  "https://graph.microsoft.com/User.Read",
];
export const microsoftConfigSchema = z.object({
  clientId: z.uuid(),
  clientSecret: z.string().min(1),
  tenant: z
    .union([z.uuid(), z.enum(["common", "organizations", "consumers"])])
    .default("common"),
  redirectUri: z.url().refine((value) => {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/api/microsoft/callback" &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    );
  }),
});
export type MicrosoftConfig = z.infer<typeof microsoftConfigSchema>;
export function microsoftFromEnv(): MicrosoftConfig | undefined {
  const parsed = microsoftConfigSchema.safeParse({
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    tenant: process.env.MICROSOFT_TENANT_ID || "common",
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
  });
  return parsed.success ? parsed.data : undefined;
}
