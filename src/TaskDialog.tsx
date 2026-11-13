import { useEffect, useRef, useState } from "react";
import {
  priorities,
  type Task,
  type Post,
  type TaskDetail,
  type Workspace,
  type Column,
  type Sprint,
} from "../shared/schema.js";
import { api } from "./api.js";

export function TaskDialog({
  task,
  columnId,
  workspace,
  onClose,
  onSaved,
  onAsk,
  onOpenBoard,
  onCreateScrum,
  defaultSprintId,
}: {
  task?: Task;
  columnId: string;
  workspace: Workspace;
  onClose: () => void;
  onSaved: (workspace: Workspace) => void;
  onAsk: (task: Task) => void;
  onOpenBoard: (id: string) => void;
  onCreateScrum: (task: Task) => void;
  defaultSprintId?: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    titleField = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(task?.title ?? ""),
    [description, setDescription] = useState(task?.description ?? "");
  const [targetBoard, setTargetBoard] = useState(
      task?.board_id ?? workspace.board.id,
    ),
    [columns, setColumns] = useState<Column[]>(workspace.columns),
    [nextColumn, setColumn] = useState(columnId);
  const [targetSprints, setTargetSprints] = useState<Sprint[]>(
      workspace.sprints,
    ),
    [sprintId, setSprintId] = useState(
      task?.sprint_id ?? defaultSprintId ?? null,
    );
  const [priority, setPriority] = useState(task?.priority ?? "normal"),
    [dueDate, setDueDate] = useState(task?.due_date ?? "");
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [posts, setPosts] = useState<Post[]>([]),
    [nextBefore, setNextBefore] = useState<number | null>(null),
    [detailTask, setDetailTask] = useState(task);
  const [postText, setPostText] = useState(""),
    [postKind, setPostKind] = useState<"note" | "update">("update"),
    [posting, setPosting] = useState(false),
    [feedError, setFeedError] = useState(""),
    [feedLoading, setFeedLoading] = useState(!!task);
  useEffect(() => {
    dialog.current?.showModal();
    titleField.current?.focus();
  }, []);
  useEffect(() => {
    if (!task) return;
    let live = true;
    void api<TaskDetail>(`/api/tasks/${task.id}`)
      .then((data) => {
        if (!live) return;
        setDetailTask(data.task);
        setPosts((previous) => {
          const byId = new Map(
            [...previous, ...data.posts].map((p) => [p.id, p]),
          );
          return [...byId.values()].sort((a, b) => b.seq - a.seq);
        });
        setNextBefore((previous) =>
          previous === null ? data.next_before : previous,
        );
        setFeedError("");
      })
      .catch((error) => {
        if (live) setFeedError(error.message);
      })
      .finally(() => {
        if (live) setFeedLoading(false);
      });
    return () => {
      live = false;
    };
  }, [task?.id, workspace.revision]);
  async function changeBoard(id: string) {
    setBusy(true);
    setError("");
    try {
      const data = await api<Workspace>(`/api/boards/${id}`);
      setTargetBoard(id);
      setColumns(data.columns);
      setTargetSprints(data.sprints);
      setSprintId(null);
      setColumn(data.columns[0].id);
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
      const values = {
        title: title.trim(),
        description,
        priority,
        due_date: dueDate || null,
        column_id: nextColumn,
        sprint_id: sprintId,
      };
      // Do not overwrite unrelated AI changes made while this editor was open.
      const body = task
        ? Object.fromEntries(
            Object.entries(values).filter(
              ([key, value]) => task[key as keyof Task] !== value,
            ),
          )
        : values;
      if (!Object.keys(body).length) {
        onClose();
        return;
      }
      const result = await api<{ workspace: Workspace }>(
        task ? `/api/tasks/${task.id}` : "/api/tasks",
        task ? "PATCH" : "POST",
        body,
      );
      onSaved(result.workspace);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ workspace: Workspace }>(
        `/api/tasks/${task.id}`,
        "DELETE",
        { confirmed: true },
      );
      onSaved(result.workspace);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (!task || !postText.trim() || posting) return;
    setPosting(true);
    setFeedError("");
    try {
      const result = await api<TaskDetail & { workspace: Workspace }>(
        `/api/tasks/${task.id}/posts`,
        "POST",
        { content: postText, kind: postKind },
      );
      setPostText("");
      setDetailTask(result.task);
      setPosts((previous) =>
        [
          ...new Map(
            [...previous, ...result.posts].map((p) => [p.id, p]),
          ).values(),
        ].sort((a, b) => b.seq - a.seq),
      );
      onSaved(result.workspace);
    } catch (error) {
      setFeedError((error as Error).message);
    } finally {
      setPosting(false);
    }
  }
  async function older() {
    if (!task || !nextBefore) return;
    setFeedLoading(true);
    setFeedError("");
    try {
      const result = await api<TaskDetail>(
        `/api/tasks/${task.id}?before=${nextBefore}`,
      );
      setPosts((previous) =>
        [
          ...new Map(
            [...previous, ...result.posts].map((p) => [p.id, p]),
          ).values(),
        ].sort((a, b) => b.seq - a.seq),
      );
      setNextBefore(result.next_before);
    } catch (error) {
      setFeedError((error as Error).message);
    } finally {
      setFeedLoading(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className={`task-dialog ${task ? "with-feed" : ""}`}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy && !posting) onClose();
      }}
      onClick={(e) => {
        if (e.target === dialog.current && !busy && !posting) onClose();
      }}
    >
      <header className="flex items-center justify-between gap-4 mb-6">
        <h2 id="dialog-title" className="text-lg font-semibold">
          {task ? "Uppgift" : "Ny uppgift"}
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Stäng uppgift"
          disabled={busy || posting}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <form onSubmit={save}>
        <fieldset disabled={busy} className="space-y-5">
          <label className="field">
            Titel
            <input
              ref={titleField}
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Vad behöver göras?"
            />
          </label>
          <label className="field">
            Beskrivning <span className="optional">valfri</span>
            <textarea
              rows={4}
              maxLength={10000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Mål, arbetssteg och hur du vet att uppgiften är klar…"
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <div className="field">
              <label htmlFor="task-board">Tavla</label>
              <select
                id="task-board"
                value={targetBoard}
                onChange={(e) => void changeBoard(e.target.value)}
              >
                {workspace.boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="task-column">Kolumn</label>
              <select
                id="task-column"
                value={nextColumn}
                onChange={(e) => setColumn(e.target.value)}
              >
                {columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {workspace.boards.find((b) => b.id === targetBoard)?.kind ===
              "scrum" && (
              <div className="field">
                <label htmlFor="task-sprint">Sprint</label>
                <select
                  id="task-sprint"
                  value={sprintId ?? ""}
                  onChange={(e) => setSprintId(e.target.value || null)}
                >
                  <option value="">Backlog · ingen sprint</option>
                  {targetSprints
                    .filter(
                      (s) =>
                        s.status !== "completed" || s.id === task?.sprint_id,
                    )
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.status === "active"
                          ? " · Aktiv"
                          : s.status === "completed"
                            ? " · Avslutad"
                            : " · Planerad"}
                      </option>
                    ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="task-priority">Prioritet</label>
              <select
                id="task-priority"
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as Task["priority"])
                }
              >
                {Object.entries(priorities).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <label className="field">
              Deadline{" "}
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                min="0001-01-01"
                max="9999-12-31"
              />
            </label>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="error mt-4">
            {error}
          </p>
        )}
        {confirm ? (
          <div className="delete-confirm mt-6">
            <p className="text-sm font-medium">
              Ta bort ”{task?.title}” och hela dess flöde?
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Det går inte att ångra.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Behåll
              </button>
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={remove}
              >
                {busy ? "Tar bort…" : "Ja, ta bort"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2 mt-6">
            {task && (
              <button
                type="button"
                className="text-button text-red-700 mr-auto"
                disabled={busy || posting}
                onClick={() => setConfirm(true)}
              >
                Ta bort
              </button>
            )}
            <button
              type="button"
              className="button"
              disabled={busy || posting}
              onClick={onClose}
            >
              {task ? "Stäng" : "Avbryt"}
            </button>
            <button className="button primary" disabled={busy || !title.trim()}>
              {busy ? "Sparar…" : task ? "Spara" : "Skapa uppgift"}
            </button>
          </div>
        )}
      </form>
      {task && workspace.board.kind === "kanban" && (
        <section
          className="master-section"
          aria-label="Scrum under masterkortet"
        >
          <h3 className="text-sm font-semibold">Scrum under det här kortet</h3>
          {(detailTask ?? task).child_board ? (
            <div className="linked-scrum">
              <div>
                <p className="text-sm font-medium">
                  {(detailTask ?? task).child_board!.name}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {(detailTask ?? task).child_board!.done_count} av{" "}
                  {(detailTask ?? task).child_board!.task_count} underkort klara
                </p>
                {(detailTask ?? task).child_board!.active_sprint_name && (
                  <p className="text-xs text-slate-400 mt-1">
                    Aktiv sprint:{" "}
                    {(detailTask ?? task).child_board!.active_sprint_name}
                  </p>
                )}
              </div>
              <button
                className="button small"
                onClick={() =>
                  onOpenBoard((detailTask ?? task).child_board!.id)
                }
              >
                Öppna Scrum-tavla →
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-400 mt-2 mb-3">
                Bryt ned masterkortets mål på en egen tavla med backlog och
                sprintar.
              </p>
              <button
                className="button small"
                disabled={busy || posting}
                onClick={() => onCreateScrum(detailTask ?? task)}
              >
                + Skapa Scrum-tavla
              </button>
              {workspace.boards.some(
                (b) => b.kind === "scrum" && !b.parent_task_id,
              ) && (
                <div className="field mt-3">
                  <label htmlFor="attach-scrum">
                    Eller koppla en befintlig Scrum-tavla
                  </label>
                  <select
                    id="attach-scrum"
                    value=""
                    disabled={busy}
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      setBusy(true);
                      setError("");
                      try {
                        const result = await api<{ workspace: Workspace }>(
                          `/api/boards/${e.target.value}`,
                          "PATCH",
                          { parent_task_id: task.id },
                        );
                        onSaved(result.workspace);
                        const detail = await api<TaskDetail>(
                          `/api/tasks/${task.id}`,
                        );
                        setDetailTask(detail.task);
                      } catch (error) {
                        setError((error as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <option value="">Välj tavla…</option>
                    {workspace.boards
                      .filter((b) => b.kind === "scrum" && !b.parent_task_id)
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </>
          )}
        </section>
      )}
      {task && (
        <section className="activity-section" aria-label="Kortets flöde">
          <header className="flex justify-between items-center gap-3 mb-4">
            <h3 className="font-semibold text-sm">Flöde</h3>
            <button
              className="button small"
              onClick={() => onAsk(detailTask ?? task)}
              disabled={posting || busy}
            >
              Fråga AI om kortet
            </button>
          </header>
          <form onSubmit={publish} className="post-composer">
            <label className="sr-only" htmlFor="post-content">
              Nytt inlägg
            </label>
            <textarea
              id="post-content"
              rows={3}
              value={postText}
              maxLength={10000}
              onChange={(e) => setPostText(e.target.value)}
              placeholder="Skriv en uppdatering, anteckning eller nästa steg…"
            />
            <div className="flex items-center justify-between gap-2 mt-2">
              <div>
                <label className="sr-only" htmlFor="post-kind">
                  Typ av inlägg
                </label>
                <select
                  id="post-kind"
                  value={postKind}
                  onChange={(e) =>
                    setPostKind(e.target.value as "note" | "update")
                  }
                >
                  <option value="update">Uppdatering</option>
                  <option value="note">Anteckning</option>
                </select>
              </div>
              <button
                className="button primary small"
                disabled={posting || !postText.trim()}
              >
                {posting ? "Publicerar…" : "Publicera"}
              </button>
            </div>
          </form>
          {feedError && (
            <p className="error my-3" role="alert">
              {feedError}
            </p>
          )}
          {feedLoading && !posts.length && (
            <p className="text-xs text-slate-400 py-3" role="status">
              Läser flödet…
            </p>
          )}
          <ol className="activity-feed">
            {posts.map((post) => (
              <li key={post.id} className={`activity-item ${post.kind}`}>
                <div
                  className={`activity-avatar ${post.author}`}
                  aria-hidden="true"
                >
                  {post.kind === "event"
                    ? "·"
                    : post.author === "assistant"
                      ? "AI"
                      : "Du"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="activity-meta">
                    <span>
                      {post.author === "assistant"
                        ? "AI-assistent"
                        : post.author === "user"
                          ? "Du"
                          : "System"}
                      {post.kind === "note"
                        ? " · Anteckning"
                        : post.kind === "update"
                          ? " · Uppdatering"
                          : ""}
                    </span>
                    <time dateTime={post.created_at}>
                      {new Date(post.created_at).toLocaleString("sv-SE", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <p className="activity-content">{post.content}</p>
                </div>
              </li>
            ))}
          </ol>
          {nextBefore && (
            <button
              className="text-button text-slate-500"
              disabled={feedLoading}
              onClick={older}
            >
              {feedLoading ? "Läser…" : "Visa äldre händelser"}
            </button>
          )}
          <p className="task-metadata">
            ID {task.id}
            <br />
            Skapad {new Date(task.created_at).toLocaleString("sv-SE")} ·
            Uppdaterad{" "}
            {new Date((detailTask ?? task).updated_at).toLocaleString("sv-SE")}
          </p>
        </section>
      )}
    </dialog>
  );
}
