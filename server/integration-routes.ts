import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { calendarId } from "../shared/calendar.js";
import { mailSearch } from "../shared/mail.js";
import { CalendarService } from "./calendar.js";
import { HttpError } from "./store.js";

export function microsoftRoutes(service: CalendarService) {
  const router = Router();
  router.get("/status", (_req, res) => res.json(service.microsoftStatus()));
  router.get("/connect", async (req, res) => {
    const origin = service.microsoftOrigin();
    if (!origin) throw new HttpError(503, service.microsoftStatus().message);
    if (req.headers.host !== new URL(origin).host)
      return res.redirect(303, `${origin}/api/microsoft/connect`);
    const cookie = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("kanban_microsoft="))
      ?.slice("kanban_microsoft=".length);
    const browser =
      cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie)
        ? cookie
        : randomBytes(32).toString("base64url");
    const url = await service.beginMicrosoft(browser);
    res.cookie("kanban_microsoft", browser, {
      httpOnly: true,
      sameSite: "lax",
      secure: origin.startsWith("https:"),
      path: "/api/microsoft",
      maxAge: 600000,
    });
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(303, url);
  });
  router.get("/callback", async (req, res) => {
    const origin = service.microsoftOrigin();
    if (!origin) throw new HttpError(503, service.microsoftStatus().message);
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.headers.host !== new URL(origin).host)
      throw new HttpError(400, "Fel adress för Microsofts inloggningssvar.");
    let status = "connected";
    try {
      const state = z.string().min(20).max(200).parse(req.query.state);
      const code = z
        .string()
        .min(1)
        .max(10000)
        .optional()
        .parse(req.query.code);
      const browser =
        req.headers.cookie
          ?.split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith("kanban_microsoft="))
          ?.slice("kanban_microsoft=".length) ?? "";
      await service.finishMicrosoft(
        state,
        browser,
        req.query.error ? undefined : code,
      );
    } catch {
      status = "failed";
    }
    res.redirect(303, `${origin}/#mail?microsoft=${status}`);
  });
  return router;
}
export function mailRoutes(service: CalendarService) {
  const router = Router();
  router.get("/accounts", (_req, res) =>
    res.json({ accounts: service.accounts() }),
  );
  router.get("/messages", async (req, res) => {
    const input = mailSearch.parse({
      ...req.query,
      offset:
        req.query.offset === undefined ? undefined : Number(req.query.offset),
      limit:
        req.query.limit === undefined ? undefined : Number(req.query.limit),
    });
    res.json(await service.searchMail(input));
  });
  router.get("/accounts/:account/messages/:id", async (req, res) =>
    res.json({
      message: await service.getMail(
        z.uuid().parse(req.params.account),
        calendarId.parse(req.params.id),
      ),
    }),
  );
  // Deliberately no POST, PATCH or DELETE mail handlers, including read/unread marking.
  return router;
}
