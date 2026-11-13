import { useEffect, useRef, useState } from "react";
import type { Sprint, Workspace } from "../shared/schema.js";
import { api } from "./api.js";
export type SprintEditor = { sprint?: Sprint };
export function SprintDialog({
  boardId,
  sprint,
  onClose,
  onSaved,
}: {
  boardId: string;
  sprint?: Sprint;
  onClose: () => void;
  onSaved: (data: Workspace, id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(sprint?.name ?? ""),
    [goal, setGoal] = useState(sprint?.goal ?? ""),
    [start, setStart] = useState(sprint?.start_date ?? ""),
    [end, setEnd] = useState(sprint?.end_date ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ workspace: Workspace; sprint: Sprint }>(
        sprint ? `/api/sprints/${sprint.id}` : `/api/boards/${boardId}/sprints`,
        sprint ? "PATCH" : "POST",
        { name, goal, start_date: start || null, end_date: end || null },
      );
      onSaved(result.workspace, result.sprint.id);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="task-dialog"
      aria-labelledby="sprint-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === dialog.current && !busy) onClose();
      }}
    >
      <form onSubmit={save}>
        <header className="flex justify-between items-center mb-6">
          <h2 id="sprint-dialog-title" className="font-semibold text-lg">
            {sprint ? "Redigera sprint" : "Ny sprint"}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Stäng sprint"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <fieldset disabled={busy} className="space-y-5">
          <label className="field">
            Namn
            <input
              ref={input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              placeholder="Till exempel Sprint 1"
            />
          </label>
          <label className="field">
            Sprintmål
            <textarea
              rows={4}
              value={goal}
              maxLength={10000}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Vilket resultat ska ni uppnå i sprinten?"
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="field">
              Startdatum
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="field">
              Slutdatum
              <input
                type="date"
                value={end}
                min={start || undefined}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
        </fieldset>
        {error && (
          <p className="error mt-4" role="alert">
            {error}
          </p>
        )}
        <footer className="flex justify-end gap-2 mt-7">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            Avbryt
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? "Sparar…" : sprint ? "Spara sprint" : "Skapa sprint"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
export function SprintPanel({
  workspace,
  view,
  onView,
  onEdit,
  onSaved,
}: {
  workspace: Workspace;
  view: string;
  onView: (view: string) => void;
  onEdit: (sprint?: Sprint) => void;
  onSaved: (data: Workspace) => void;
}) {
  const sprint = workspace.sprints.find((s) => s.id === view);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setError("");
    setConfirm(false);
  }, [view]);
  async function transition(action: "start" | "complete") {
    if (!sprint) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ workspace: Workspace }>(
        `/api/sprints/${sprint.id}/${action}`,
        "POST",
        {},
      );
      onSaved(result.workspace);
      setConfirm(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sprint-panel" aria-label="Sprintplanering">
      <div className="sprint-toolbar">
        <div className="sprint-picker">
          <label htmlFor="sprint-view">Visa</label>
          <select
            id="sprint-view"
            value={view}
            onChange={(e) => onView(e.target.value)}
          >
            <option value="backlog">Backlog</option>
            {workspace.sprints.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.status === "active"
                  ? " · Aktiv"
                  : s.status === "completed"
                    ? " · Avslutad"
                    : " · Planerad"}
              </option>
            ))}
            <option value="all">Alla kort</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="button small" onClick={() => onEdit()}>
            + Ny sprint
          </button>
          {sprint && (
            <button className="button small" onClick={() => onEdit(sprint)}>
              Redigera sprint
            </button>
          )}
          {sprint?.status === "planned" && (
            <button
              className="button primary small"
              disabled={busy}
              onClick={() => transition("start")}
            >
              Starta sprint
            </button>
          )}
          {sprint?.status === "active" && (
            <button
              className="button small"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              Avsluta sprint
            </button>
          )}
        </div>
      </div>
      {sprint ? (
        <div className="sprint-summary">
          <p>
            <span className={`sprint-state ${sprint.status}`}>
              {sprint.status === "active"
                ? "Aktiv sprint"
                : sprint.status === "completed"
                  ? "Avslutad sprint"
                  : "Planerad sprint"}
            </span>
            <span>
              {sprint.done_count} av {sprint.task_count} kort klara
            </span>
            {(sprint.start_date || sprint.end_date) && (
              <span>
                {sprint.start_date ?? "—"} → {sprint.end_date ?? "—"}
              </span>
            )}
          </p>
          {sprint.goal && <p className="sprint-goal">{sprint.goal}</p>}
          {sprint.status === "completed" && (
            <p className="field-help">
              Sprintens kort är bevarade. Återför ofärdiga kort till backlog
              från kortets sprintval vid behov.
            </p>
          )}
        </div>
      ) : (
        <p className="sprint-hint">
          {view === "backlog"
            ? "Kort som ännu inte är planerade i en sprint. Öppna ett kort och välj sprint för att planera arbetet."
            : "Alla kort på Scrum-tavlan, inklusive tidigare sprintar."}
        </p>
      )}
      {confirm && sprint && (
        <div className="sprint-confirm">
          <p>
            Avsluta ”{sprint.name}”? {sprint.task_count - sprint.done_count}{" "}
            ofärdiga kort finns kvar i sprinten. Masterkortets status ändras
            inte.
          </p>
          <div className="flex gap-2">
            <button
              className="button small"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Avbryt
            </button>
            <button
              className="button primary small"
              disabled={busy}
              onClick={() => transition("complete")}
            >
              {busy ? "Avslutar…" : "Ja, avsluta sprint"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="error mt-3" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
