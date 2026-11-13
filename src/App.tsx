import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiStatus,
  Workspace,
  Task,
  AiWork,
  AiJob,
} from "../shared/schema.js";
import { api } from "./api.js";
import { JobRail } from "./JobRail.js";
import { Board } from "./Board.js";
import { TaskDialog } from "./TaskDialog.js";
import { SprintDialog, SprintPanel, type SprintEditor } from "./SprintPanel.js";
import { AiPanel } from "./AiPanel.js";
import { StructureDialog, type StructureEditor } from "./StructureDialog.js";
import { Icon } from "./Icon.js";

const NEW_BOARD = "__new_board";

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [status, setStatus] = useState<AiStatus>();
  const [aiOpen, setAiOpen] = useState(false),
    [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [editor, setEditor] = useState<{ task?: Task; columnId: string }>(),
    [structure, setStructure] = useState<StructureEditor>();
  const [sprintView, setSprintView] = useState("auto"),
    [sprintEditor, setSprintEditor] = useState<SprintEditor>();
  const effectiveView =
    sprintView === "auto"
      ? (workspace?.sprints.find((s) => s.status === "active")?.id ?? "backlog")
      : sprintView;
  const selectedSprint = workspace?.sprints.find((s) => s.id === effectiveView);
  const visibleTasks =
    workspace?.tasks.filter(
      (t) =>
        workspace.board.kind !== "scrum" ||
        effectiveView === "all" ||
        (effectiveView === "backlog"
          ? t.sprint_id === null
          : t.sprint_id === effectiveView),
    ) ?? [];
  const visibleColumns =
    workspace?.columns.filter(
      (c) =>
        workspace.board.kind !== "scrum" ||
        !selectedSprint ||
        c.key !== "backlog",
    ) ?? [];
  const [moving, setMoving] = useState(false),
    [mobile, setMobile] = useState(
      () => window.matchMedia("(max-width:767px)").matches,
    );
  const [work, setWork] = useState<AiWork>({
    jobs: [],
    conversations: [],
    pending: [],
    revision: 0,
  });
  const [conversationId, setConversationId] = useState<string | undefined>(
    () => {
      try {
        return localStorage.getItem("kanban-conversation") ?? undefined;
      } catch {
        return undefined;
      }
    },
  );
  const ownedJobs = useRef(new Set<string>()),
    handledQuestions = useRef(new Set<string>());
  const autoJob = useRef<string | undefined>(undefined),
    pollRef = useRef<() => void>(() => {});
  useEffect(() => {
    try {
      if (conversationId)
        localStorage.setItem("kanban-conversation", conversationId);
      else localStorage.removeItem("kanban-conversation");
    } catch {}
  }, [conversationId]);
  const active = useRef<string | undefined>(undefined),
    latestRevision = useRef(-1);
  useEffect(() => {
    const media = window.matchMedia("(max-width:767px)");
    const changed = () => setMobile(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const refreshStatus = useCallback(() => {
    void api<AiStatus>("/api/ai/status")
      .then(setStatus)
      .catch(() =>
        setStatus({
          available: false,
          model: "",
          message: "Kan inte nå servern.",
        }),
      );
  }, []);
  const load = useCallback(async (boardId?: string) => {
    try {
      const boards = (await api<{ boards: Workspace["boards"] }>("/api/boards"))
        .boards;
      const requested = boardId ?? active.current;
      const id = boards.find((b) => b.id === requested)?.id ?? boards[0]?.id;
      if (!boards.some((b) => b.id === active.current)) active.current = id;
      if (!id) throw new Error("Ingen tavla hittades.");
      if (!active.current) active.current = id;
      const data = await api<Workspace>(`/api/boards/${id}`);
      if (active.current === id && data.revision >= latestRevision.current) {
        latestRevision.current = data.revision;
        setWorkspace(data);
        setError("");
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  const applyWorkspace = useCallback(
    (data: Workspace) => {
      if (data.revision < latestRevision.current) return;
      latestRevision.current = data.revision;
      if (!data.boards.some((b) => b.id === active.current)) {
        active.current = data.board.id;
        setSelectedTaskId(undefined);
        setEditor(undefined);
        setSprintView("auto");
      }
      if (data.board.id === active.current) setWorkspace(data);
      else {
        setWorkspace((previous) =>
          previous ? { ...previous, boards: data.boards } : previous,
        );
        void load();
      }
    },
    [load],
  );
  useEffect(() => {
    void load();
    refreshStatus();
    const focus = () => {
      void load();
      refreshStatus();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [load, refreshStatus]);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await api<AiWork>("/api/ai/work");
        if (!alive) return;
        setWork(data);
        if (data.revision > latestRevision.current) void load();
        const question = data.jobs.find(
          (j) =>
            j.status === "needs_input" &&
            ownedJobs.current.has(j.id) &&
            !handledQuestions.current.has(j.id),
        );
        if (question) {
          handledQuestions.current.add(question.id);
          autoJob.current = undefined;
          setConversationId(question.conversation_id);
          setAiOpen(true);
          active.current = question.board_id;
          setSelectedTaskId(question.task_id ?? undefined);
          setSprintView(question.sprint_id ?? "auto");
          void load(question.board_id);
        }
        const job = data.jobs.find((j) => j.id === autoJob.current);
        if (job) {
          if (job.status === "running" && job.stage === "working")
            setAiOpen(false);
          if (job.status === "needs_input") {
            setAiOpen(true);
            autoJob.current = undefined;
          } else if (
            ["completed", "failed", "cancelled", "interrupted"].includes(
              job.status,
            )
          ) {
            if (job.status === "completed") setAiOpen(false);
            autoJob.current = undefined;
          }
        }
      } catch {
      } finally {
        inFlight = false;
        if (alive) {
          clearTimeout(timer);
          timer = setTimeout(() => void poll(), 1200);
        }
      }
    };
    pollRef.current = () => void poll();
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load]);
  function openConversation(id?: string, job?: AiJob) {
    autoJob.current = undefined;
    setConversationId(id);
    setAiOpen(true);
    const boardId =
      job?.board_id ?? work.conversations.find((c) => c.id === id)?.board_id;
    if (boardId && workspace?.boards.some((b) => b.id === boardId)) {
      selectBoard(boardId);
      setSelectedTaskId(job?.task_id ?? undefined);
      setSprintView(job?.sprint_id ?? "auto");
    }
  }
  function submitted(job: AiJob) {
    ownedJobs.current.add(job.id);
    setConversationId(job.conversation_id);
    autoJob.current = job.id;
    if (work.jobs.some((j) => j.status === "running" && j.id !== job.id))
      setAiOpen(false);
  }
  function selectBoard(id: string) {
    active.current = id;
    setEditor(undefined);
    setSprintView("auto");
    setSelectedTaskId(undefined);
    setLoading(true);
    void load(id);
  }
  async function openMaster() {
    if (!workspace?.board.parent_task_id || !workspace.board.parent_board_id)
      return;
    try {
      const data = await api<Workspace>(
        `/api/boards/${workspace.board.parent_board_id}`,
      );
      active.current = data.board.id;
      setSprintView("auto");
      applyWorkspace(data);
      const task = data.tasks.find(
        (t) => t.id === workspace.board.parent_task_id,
      );
      if (task) setEditor({ task, columnId: task.column_id });
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function move(id: string, columnId: string, position: number) {
    const global = (workspace?.tasks ?? []).filter(
      (t) => t.column_id === columnId && t.id !== id,
    );
    const visible = visibleTasks.filter(
      (t) => t.column_id === columnId && t.id !== id,
    );
    position = visible[position]
      ? global.findIndex((t) => t.id === visible[position].id)
      : visible.length
        ? global.findIndex((t) => t.id === visible.at(-1)!.id) + 1
        : global.length;
    setMoving(true);
    setError("");
    try {
      const result = await api<{ workspace: Workspace }>(
        `/api/tasks/${id}`,
        "PATCH",
        { column_id: columnId, position },
      );
      applyWorkspace(result.workspace);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setMoving(false);
    }
  }
  const closeAi = useCallback(() => setAiOpen(false), []);
  const selected = workspace?.tasks.find((t) => t.id === selectedTaskId);
  const statusText = status?.available
    ? `Ollama ansluten (${status.model})`
    : status
      ? "Ollama frånkopplad"
      : "Kontrollerar Ollama…";
  return (
    <div className="app-shell">
      <header className="app-header" inert={aiOpen && mobile}>
        <div className="header-start">
          <a className="brand" href="/" aria-label="Kanban, startsida">
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M4 4v12m6-12v8m6-12v10" strokeLinecap="round" />
            </svg>
          </a>
          <h1 className="sr-only">Kanban</h1>
          {workspace && (
            <>
              <label className="sr-only" htmlFor="board-picker">
                Tavla
              </label>
              <select
                id="board-picker"
                className="board-select"
                value={workspace.board.id}
                onChange={(e) =>
                  e.target.value === NEW_BOARD
                    ? setStructure({ kind: "board" })
                    : selectBoard(e.target.value)
                }
              >
                <optgroup label="Kanban">
                  {workspace.boards
                    .filter((b) => b.kind !== "scrum")
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                </optgroup>
                {workspace.boards.some((b) => b.kind === "scrum") && (
                  <optgroup label="Scrum">
                    {workspace.boards
                      .filter((b) => b.kind === "scrum")
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                  </optgroup>
                )}
                <option value={NEW_BOARD}>+ Ny tavla…</option>
              </select>
              <button
                className="icon-button"
                data-tip="Tavlans inställningar"
                aria-label="Tavlans inställningar"
                onClick={() =>
                  setStructure({ kind: "board", board: workspace.board })
                }
              >
                <Icon name="settings" />
              </button>
            </>
          )}
        </div>
        <JobRail
          jobs={work.jobs}
          onOpen={(job) => openConversation(job.conversation_id, job)}
          onNew={() => openConversation()}
          onRefresh={() => pollRef.current()}
        />
        <div className="header-end">
          <button
            className={`button ai-toggle ${aiOpen ? "active" : ""}`}
            aria-expanded={aiOpen}
            data-tip={statusText}
            data-tip-end=""
            onClick={() => {
              autoJob.current = undefined;
              setAiOpen((value) => !value);
              refreshStatus();
            }}
          >
            <span
              className={`status-dot ${status?.available ? "online" : status ? "offline" : ""}`}
              aria-hidden="true"
            />
            <span className="ai-label">AI-assistent</span>
            <span className="sr-only">, {statusText}</span>
          </button>
          <button
            className="button primary"
            aria-label="Ny uppgift"
            disabled={!workspace || selectedSprint?.status === "completed"}
            onClick={() =>
              workspace && setEditor({ columnId: visibleColumns[0].id })
            }
          >
            <Icon name="plus" size={16} />
            <span className="new-task-label">Ny uppgift</span>
          </button>
        </div>
      </header>
      <div className="workspace">
        <main className="board-area" inert={aiOpen && mobile}>
          {workspace && (
            <>
              {(workspace.board.parent_task_id ||
                workspace.board.description) && (
                <div className="board-intro">
                  {workspace.board.parent_task_id && (
                    <button
                      className="back-link"
                      onClick={() => void openMaster()}
                    >
                      <Icon name="back" size={16} />
                      {workspace.board.parent_board_name} /{" "}
                      {workspace.board.parent_task_title}
                    </button>
                  )}
                  {workspace.board.description && (
                    <p className="board-purpose">
                      {workspace.board.description}
                    </p>
                  )}
                </div>
              )}
              {workspace.board.kind === "scrum" && (
                <SprintPanel
                  workspace={workspace}
                  view={effectiveView}
                  onView={setSprintView}
                  onEdit={(sprint) => setSprintEditor({ sprint })}
                  onSaved={(data) => {
                    setSprintView(effectiveView);
                    applyWorkspace(data);
                  }}
                />
              )}
            </>
          )}
          {error && (
            <div className="error board-error" role="alert">
              {error}
              <button className="text-button" onClick={() => void load()}>
                Försök igen
              </button>
            </div>
          )}
          {loading ? (
            <p role="status" className="board-loading">
              Läser tavlan…
            </p>
          ) : (
            workspace && (
              <Board
                tasks={visibleTasks}
                columns={visibleColumns}
                creationDisabled={selectedSprint?.status === "completed"}
                onOpenBoard={selectBoard}
                disabled={moving}
                onCreate={(columnId) => setEditor({ columnId })}
                onEdit={(task) => setEditor({ task, columnId: task.column_id })}
                onMove={move}
                onAddColumn={() =>
                  setStructure({
                    kind: "column",
                    boardId: workspace.board.id,
                    count: workspace.columns.length,
                  })
                }
                onColumnEdit={(column) =>
                  setStructure({
                    kind: "column",
                    boardId: workspace.board.id,
                    column,
                    count: workspace.columns.length,
                  })
                }
              />
            )
          )}
          {moving && (
            <span className="sr-only" role="status">
              Sparar kortets position…
            </span>
          )}
        </main>
        {workspace && (
          <AiPanel
            open={aiOpen}
            onClose={closeAi}
            status={status}
            workspace={workspace}
            selectedTask={selected}
            sprintId={
              workspace.board.kind === "scrum" ? selectedSprint?.id : undefined
            }
            onClearTask={() => setSelectedTaskId(undefined)}
            onWorkspace={applyWorkspace}
            refreshStatus={refreshStatus}
            work={work}
            conversationId={conversationId}
            onConversation={openConversation}
            onSubmitted={submitted}
            onRefresh={() => pollRef.current()}
          />
        )}
      </div>
      {editor && workspace && (
        <TaskDialog
          task={editor.task}
          columnId={editor.columnId}
          workspace={workspace}
          onClose={() => setEditor(undefined)}
          onSaved={applyWorkspace}
          defaultSprintId={selectedSprint?.id}
          onOpenBoard={selectBoard}
          onCreateScrum={(task) => {
            setEditor(undefined);
            setStructure({ kind: "board", scrum: true, parentTask: task });
          }}
          onAsk={(task) => {
            setSelectedTaskId(task.id);
            setEditor(undefined);
            setAiOpen(true);
          }}
        />
      )}
      {sprintEditor && workspace && (
        <SprintDialog
          boardId={workspace.board.id}
          sprint={sprintEditor.sprint}
          onClose={() => setSprintEditor(undefined)}
          onSaved={(data, id) => {
            applyWorkspace(data);
            setSprintView(id);
          }}
        />
      )}
      {structure && (
        <StructureDialog
          editor={structure}
          onClose={() => setStructure(undefined)}
          onSaved={(data, created) => {
            if (created) {
              active.current = data.board.id;
              setSprintView("auto");
              setSelectedTaskId(undefined);
            }
            applyWorkspace(data);
          }}
        />
      )}
    </div>
  );
}
