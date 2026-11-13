import { useEffect, useRef, useState } from "react";
import type { BoardInfo, Column, Workspace } from "../shared/schema.js";
import { api } from "./api.js";
import { Icon } from "./Icon.js";

export type StructureEditor =
  | {
      kind: "board";
      board?: BoardInfo;
      scrum?: boolean;
      parentTask?: { id: string; title: string; description: string };
    }
  | { kind: "column"; boardId: string; column?: Column; count: number };
export function StructureDialog({
  editor,
  onClose,
  onSaved,
}: {
  editor: StructureEditor;
  onClose: () => void;
  onSaved: (workspace: Workspace, createdBoard: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    nameField = useRef<HTMLInputElement>(null);
  const original = editor.kind === "board" ? editor.board : editor.column;
  const [name, setName] = useState(
      original?.name ??
        (editor.kind === "board" && editor.parentTask
          ? `${editor.parentTask.title} – Scrum`
          : ""),
    ),
    [description, setDescription] = useState(
      original?.description ??
        (editor.kind === "board" ? (editor.parentTask?.description ?? "") : ""),
    );
  const [instructions, setInstructions] = useState(
    editor.kind === "board" ? (editor.board?.instructions ?? "") : "",
  );
  const [boardKind, setBoardKind] = useState<"kanban" | "scrum">(
    editor.kind === "board"
      ? (editor.board?.kind ?? (editor.scrum ? "scrum" : "kanban"))
      : "kanban",
  );
  const [parentId, setParentId] = useState(
    editor.kind === "board"
      ? (editor.board?.parent_task_id ?? editor.parentTask?.id ?? null)
      : null,
  );
  const [done, setDone] = useState(
    editor.kind === "column" ? (editor.column?.is_done ?? false) : false,
  );
  const [position, setPosition] = useState(
    editor.kind === "column" ? (editor.column?.position ?? editor.count) : 0,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    nameField.current?.focus();
  }, []);
  const [deleting, setDeleting] = useState(false);
  async function remove() {
    if (editor.kind !== "board" || !editor.board) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ workspace: Workspace }>(
        `/api/boards/${editor.board.id}`,
        "DELETE",
        { confirmed: true },
      );
      onSaved(result.workspace, true);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const board = editor.kind === "board";
      const path = board
        ? original
          ? `/api/boards/${original.id}`
          : "/api/boards"
        : original
          ? `/api/columns/${original.id}`
          : `/api/boards/${editor.boardId}/columns`;
      const body = board
        ? {
            name,
            description,
            instructions,
            ...(original ? {} : { kind: boardKind }),
            parent_task_id: parentId,
          }
        : { name, description, is_done: done, position };
      const result = await api<{ workspace: Workspace }>(
        path,
        original ? "PATCH" : "POST",
        body,
      );
      onSaved(result.workspace, board && !original);
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
      aria-labelledby="structure-title"
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
          <h2 id="structure-title" className="font-semibold text-lg">
            {original ? "Redigera" : "Ny"}{" "}
            {editor.kind === "board" ? "tavla" : "kolumn"}
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Stäng inställningar"
          >
            <Icon name="close" />
          </button>
        </header>
        <fieldset disabled={busy} className="space-y-5">
          {editor.kind === "board" && !original && (
            <div className="field">
              <label htmlFor="board-kind">Typ av tavla</label>
              <select
                id="board-kind"
                value={boardKind}
                disabled={!!editor.parentTask}
                onChange={(e) =>
                  setBoardKind(e.target.value as "kanban" | "scrum")
                }
              >
                <option value="kanban">Kanban</option>
                <option value="scrum">Scrum</option>
              </select>
            </div>
          )}
          {editor.kind === "board" && parentId && (
            <div className="master-link-info">
              <p>
                Under masterkortet{" "}
                <strong>
                  {editor.parentTask?.title ?? editor.board?.parent_task_title}
                </strong>
              </p>
              {original && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setParentId(null)}
                >
                  Frikoppla från masterkortet
                </button>
              )}
            </div>
          )}
          <label className="field">
            Namn
            <input
              ref={nameField}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              placeholder={
                editor.kind === "board"
                  ? "Till exempel Hemmaserver"
                  : "Till exempel Granskning"
              }
            />
          </label>
          <label className="field">
            {editor.kind === "board"
              ? "Mål och beskrivning"
              : "Vad hör hemma här?"}
            <textarea
              rows={3}
              value={description}
              maxLength={editor.kind === "board" ? 10000 : 2000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                editor.kind === "board"
                  ? "Vad vill du uppnå på den här tavlan?"
                  : "Beskriv när ett kort ska ligga i kolumnen."
              }
            />
          </label>
          {editor.kind === "board" ? (
            <label className="field">
              AI-instruktioner <span className="optional">valfritt</span>
              <textarea
                rows={5}
                value={instructions}
                maxLength={10000}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Till exempel: Bryt ned arbete i små steg. Beskriv hur varje steg verifieras. Dokumentera hinder och nästa steg i kortets flöde."
              />
              <span className="field-help">
                Assistenten läser detta tillsammans med tavlans kort och flöden.
              </span>
            </label>
          ) : (
            <>
              <div className="field">
                <label htmlFor="column-position">Placering</label>
                <select
                  id="column-position"
                  value={position}
                  onChange={(e) => setPosition(Number(e.target.value))}
                >
                  {Array.from(
                    { length: editor.count + (original ? 0 : 1) },
                    (_, i) => (
                      <option key={i} value={i}>
                        {i + 1}
                      </option>
                    ),
                  )}
                </select>
              </div>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={done}
                  onChange={(e) => setDone(e.target.checked)}
                />
                Kort i den här kolumnen är klara
              </label>
            </>
          )}
        </fieldset>
        {error && (
          <p className="error mt-4" role="alert">
            {error}
          </p>
        )}
        {editor.kind === "board" && editor.board && (
          <section className="board-delete">
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={() => setDeleting(!deleting)}
            >
              Ta bort tavla
            </button>
            {deleting && (
              <div className="delete-confirm mt-3">
                <p>
                  Ta bort ”{editor.board.name}” och dess{" "}
                  {editor.board.task_count} kort, sprintar och flöden?
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    type="button"
                    className="button small"
                    disabled={busy}
                    onClick={() => setDeleting(false)}
                  >
                    Behåll tavlan
                  </button>
                  <button
                    type="button"
                    className="button small danger"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    Ja, ta bort tavlan
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
        <footer className="flex justify-end gap-2 mt-7">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={busy}
          >
            Avbryt
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy
              ? "Sparar…"
              : original
                ? "Spara"
                : editor.kind === "board"
                  ? "Skapa tavla"
                  : "Skapa kolumn"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
