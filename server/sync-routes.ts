import { Router } from "express";
import { z } from "zod";
import type { IntegrationSync } from "./integration-sync.js";

export function syncRoutes(sync: IntegrationSync) {
  const router = Router();
  router.get("/status", (_req, res) => res.json(sync.status()));
  router.put("/settings", (req, res) => res.json(sync.configure(req.body)));
  router.post("/refresh", (_req, res) => res.json(sync.wake()));
  router.post("/runs", (req, res) =>
    res.status(202).json({ run: sync.request(req.body) }),
  );
  router.get("/runs/:id", (req, res) =>
    res.json({ run: sync.run(z.uuid().parse(req.params.id)) }),
  );
  router.post("/runs/:id/cancel", (req, res) =>
    res.json({ run: sync.cancel(z.uuid().parse(req.params.id)) }),
  );
  router.get("/items", (req, res) =>
    res.json(
      sync.search({
        ...req.query,
        ...(req.query.offset === undefined
          ? {}
          : { offset: Number(req.query.offset) }),
        ...(req.query.limit === undefined
          ? {}
          : { limit: Number(req.query.limit) }),
        ...(req.query.min_urgency === undefined
          ? {}
          : { min_urgency: Number(req.query.min_urgency) }),
      }),
    ),
  );
  router.get("/items/:id", (req, res) =>
    res.json({ item: sync.item(z.uuid().parse(req.params.id)) }),
  );
  router.post("/lookup", (req, res) => {
    const input = z
      .object({
        account_id: z.uuid(),
        ids: z.array(z.string().min(1).max(2000)).max(50),
      })
      .strict()
      .parse(req.body);
    res.json({ items: sync.lookup(input.account_id, input.ids) });
  });
  router.get("/workflow", (_req, res) =>
    res.json({
      ignored: sync.workflow.ignores(),
      feedback: sync.workflow.feedbackList(),
    }),
  );
  router.post("/ignore", (req, res) =>
    res.json({ ignored: sync.workflow.addIgnore(req.body) }),
  );
  router.delete("/ignore/:id", (req, res) =>
    res.json({ ignored: sync.workflow.removeIgnore(String(req.params.id)) }),
  );
  router.get("/tasks/:id/proposal", (req, res) =>
    res.json(sync.workflow.taskInfo(z.uuid().parse(req.params.id))),
  );
  router.post("/tasks/:id/reject", (req, res) =>
    res.json(
      sync.workflow.reject({ ...req.body, id: z.uuid().parse(req.params.id) }),
    ),
  );
  router.post("/tasks/:id/wait", (req, res) =>
    res.json({
      task: sync.workflow.wait({
        ...req.body,
        id: z.uuid().parse(req.params.id),
      }),
    }),
  );
  router.get("/daily", (req, res) =>
    res.json(
      sync.workflow.daily(
        req.query.day === undefined
          ? undefined
          : z.iso.date().parse(req.query.day),
      ),
    ),
  );
  return router;
}
