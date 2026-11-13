import { Router } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { calendarId } from "../shared/calendar.js";
import { CalendarService } from "./calendar.js";
import { HttpError } from "./store.js";

export function calendarRoutes(calendar: CalendarService) {
  const router = Router();
  router.get("/guide", (_req, res) =>
    res
      .type("text/plain")
      .send(readFileSync(resolve(process.cwd(), "docs/CALENDAR.md"), "utf8")),
  );
  router.use((req, _res, next) => {
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.get("X-Calendar-Action") !== "manual"
    )
      return next(
        new HttpError(
          403,
          "Kalenderändringar görs manuellt i kalenderns gränssnitt.",
        ),
      );
    next();
  });
  router.get("/accounts", (_req, res) =>
    res.json({ accounts: calendar.accounts() }),
  );
  router.post("/accounts", async (req, res) =>
    res.status(201).json({ account: await calendar.add(req.body) }),
  );
  router.patch("/accounts/:id", (req, res) => {
    calendar.permissions(z.uuid().parse(req.params.id), req.body);
    res.json({ ok: true });
  });
  router.delete("/accounts/:id", (req, res) => {
    z.object({}).strict().parse(req.body);
    calendar.remove(z.uuid().parse(req.params.id));
    res.json({ ok: true });
  });
  router.post("/accounts/:id/login", (req, res) => {
    throw new HttpError(
      410,
      "Använd Anslut Microsoft-konto för e-post och kalender.",
    );
  });
  router.get("/events", async (req, res) =>
    res.json(
      await calendar.list(
        { start: req.query.start, end: req.query.end },
        z.uuid().optional().parse(req.query.account_id),
      ),
    ),
  );
  router.get("/accounts/:id/events/:event", async (req, res) =>
    res.json({
      event: await calendar.get(
        z.uuid().parse(req.params.id),
        calendarId.parse(req.params.event),
      ),
    }),
  );
  router.post("/accounts/:id/events", async (req, res) => {
    await calendar.write(
      z.uuid().parse(req.params.id),
      "create",
      undefined,
      undefined,
      req.body,
    );
    res.status(201).json({ ok: true });
  });
  router.patch("/accounts/:id/events/:event", async (req, res) => {
    const { version, event } = z
      .object({ version: z.string().min(1).max(2000), event: z.unknown() })
      .strict()
      .parse(req.body);
    await calendar.write(
      z.uuid().parse(req.params.id),
      "update",
      calendarId.parse(req.params.event),
      version,
      event,
    );
    res.json({ ok: true });
  });
  router.delete("/accounts/:id/events/:event", async (req, res) => {
    const { version } = z
      .object({ version: z.string().min(1).max(2000) })
      .strict()
      .parse(req.body);
    await calendar.write(
      z.uuid().parse(req.params.id),
      "delete",
      calendarId.parse(req.params.event),
      version,
    );
    res.json({ ok: true });
  });
  return router;
}
