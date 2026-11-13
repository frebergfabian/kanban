import { useEffect, useRef, useState } from "react";
import type {
  AiStatus,
  AiWork,
  AiJob,
  Task,
  Workspace,
  ChatMessage,
  Memory,
  AuditLog,
  ExternalContext,
} from "../shared/schema.js";
import { api, requestId } from "./api.js";
import { Icon } from "./Icon.js";
export function AiPanel({
  open,
  onClose,
  status,
  workspace,
  selectedTask,
  sprintId,
  onClearTask,
  onWorkspace,
  refreshStatus,
  work,
  conversationId,
  onConversation,
  onSubmitted,
  onRefresh,
  externalContext,
  onClearExternal,
}: {
  open: boolean;
  onClose: () => void;
  status?: AiStatus;
  workspace: Workspace;
  selectedTask?: Task;
  sprintId?: string | null;
  onClearTask: () => void;
  onWorkspace: (w: Workspace) => void;
  refreshStatus: () => void;
  work: AiWork;
  conversationId?: string;
  onConversation: (id?: string) => void;
  onSubmitted: (job: AiJob) => void;
  onRefresh: () => void;
  externalContext?: ExternalContext;
  onClearExternal?: () => void;
}) {
  const [tab, setTab] = useState<"chat" | "history" | "memory" | "logs">(
      "chat",
    ),
    [input, setInput] = useState(""),
    [sending, setSending] = useState(false),
    [error, setError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [next, setNext] = useState<number | null>(null),
    [historyQuery, setHistoryQuery] = useState(""),
    [hits, setHits] = useState<(ChatMessage & { title: string })[] | null>(
      null,
    );
  const [memories, setMemories] = useState<Memory[]>([]),
    [memoryKey, setMemoryKey] = useState(""),
    [memoryContent, setMemoryContent] = useState(""),
    [memoryGlobal, setMemoryGlobal] = useState(false),
    [memoryKind, setMemoryKind] = useState("preference");
  const [logs, setLogs] = useState<AuditLog[]>([]),
    [logQuery, setLogQuery] = useState(""),
    [logNext, setLogNext] = useState<number | null>(null),
    [help, setHelp] = useState(""),
    [confirmBusy, setConfirmBusy] = useState("");
  const panel = useRef<HTMLElement>(null),
    field = useRef<HTMLTextAreaElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    opener = useRef<HTMLElement | null>(null);
  const currentJobs = work.jobs.filter(
      (j) => j.conversation_id === conversationId,
    ),
    current =
      currentJobs.find((j) => j.status === "running") ??
      currentJobs.find((j) => j.status === "queued"),
    pending = work.pending.filter((p) => p.conversation_id === conversationId);
  const stamp = currentJobs
    .map((j) => j.status + j.progress + j.finished_at)
    .join("|");
  useEffect(() => {
    setMessages([]);
    setNext(null);
    setError("");
    setTab("chat");
  }, [conversationId]);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement;
    field.current?.focus();
    return () => opener.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open || !conversationId || tab !== "chat") return;
    let alive = true;
    api<{ messages: ChatMessage[]; next_offset: number | null }>(
      `/api/ai/conversations/${conversationId}`,
    )
      .then((data) => {
        if (alive) {
          setMessages(data.messages);
          setNext(data.next_offset);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [open, conversationId, stamp, tab]);
  useEffect(() => {
    if (open && tab === "chat")
      bottom.current?.scrollIntoView({ block: "end" });
  }, [open, messages.length, stamp, tab]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]"))
        onClose();
      if (e.key === "Tab" && matchMedia("(max-width:767px)").matches) {
        const items = panel.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select,summary",
        );
        if (!items?.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, onClose]);
  function openChat(id: string) {
    setTab("chat");
    onConversation(id);
  }
  async function loadMemories() {
    try {
      const data = await api<{ memories: Memory[] }>(
        `/api/ai/memories?board_id=${workspace.board.id}`,
      );
      setMemories(data.memories);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function loadLogs(offset = 0) {
    try {
      const data = await api<{ logs: AuditLog[]; next_offset: number | null }>(
        `/api/ai/logs?query=${encodeURIComponent(logQuery)}&offset=${offset}`,
      );
      setLogs((old) => (offset ? [...old, ...data.logs] : data.logs));
      setLogNext(data.next_offset);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!open) return;
    if (tab === "memory") void loadMemories();
    if (tab === "logs") void loadLogs();
  }, [open, tab, workspace.board.id]);
  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!input.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      const { job } = await api<{ job: AiJob }>("/api/ai/jobs", "POST", {
        request_id: requestId(),
        message: input.trim(),
        ...(conversationId ? { conversation_id: conversationId } : {}),
        board_id: workspace.board.id,
        ...(selectedTask ? { task_id: selectedTask.id } : {}),
        ...(sprintId ? { sprint_id: sprintId } : {}),
        ...(externalContext ? { external_context: externalContext } : {}),
      });
      setInput("");
      setTab("chat");
      onSubmitted(job);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function approve(id: string, approve: boolean) {
    setConfirmBusy(id);
    setError("");
    try {
      const data = await api<{ workspace?: Workspace }>(
        `/api/ai/confirmations/${id}`,
        "POST",
        { approve },
      );
      if (data.workspace) onWorkspace(data.workspace);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConfirmBusy("");
    }
  }
  async function moreMessages() {
    if (!conversationId || next === null) return;
    try {
      const data = await api<{
        messages: ChatMessage[];
        next_offset: number | null;
      }>(`/api/ai/conversations/${conversationId}?offset=${next}`);
      setMessages((old) => [...old, ...data.messages]);
      setNext(data.next_offset);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <aside
      ref={panel}
      className={`ai-panel ${open ? "is-open" : ""}`}
      aria-label="AI-assistent"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="panel-header">
        <h2 className="panel-title">AI-assistent</h2>
        <button
          className="icon-button"
          aria-label="Stäng AI-assistent"
          title="Jobben fortsätter på servern"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <nav className="ai-tabs" aria-label="AI-vyer">
        {(["chat", "history", "memory", "logs"] as const).map((key, i) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            aria-pressed={tab === key}
            onClick={() => {
              setTab(key);
              setError("");
            }}
          >
            {["Chatt", "Historik", "Minne", "Loggar"][i]}
          </button>
        ))}
      </nav>
      <div className="ai-context">
        <span className="context-label">Tavla</span>
        <strong>{workspace.board.name}</strong>
        {sprintId && (
          <p className="text-xs text-slate-500 mt-1">
            Sprint: {workspace.sprints.find((s) => s.id === sprintId)?.name}
          </p>
        )}
        {workspace.board.parent_task_title && (
          <p className="text-xs text-slate-500 mt-1">
            Master: {workspace.board.parent_task_title}
          </p>
        )}
        {externalContext && (
          <div className="selected-task">
            <span>
              {externalContext.kind === "mail"
                ? "Valt mejl"
                : "Vald kalenderhändelse"}{" "}
              · Endast läsning
            </span>
            <button
              className="icon-button"
              aria-label="Ta bort vald källa från AI-kontext"
              onClick={onClearExternal}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {selectedTask && (
          <div className="selected-task">
            <span>Kort: {selectedTask.title}</span>
            <button
              className="icon-button"
              aria-label="Rensa valt AI-kort"
              onClick={onClearTask}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {tab === "chat" && (
          <div className="flex justify-between items-center mt-3">
            <button
              className="text-button"
              onClick={() => {
                onConversation(undefined);
                setInput("");
              }}
            >
              + Nytt samtal
            </button>
            <details
              onToggle={(e) => {
                if (e.currentTarget.open && !help)
                  void api<{ guide: string }>("/api/ai/help")
                    .then((d) => setHelp(d.guide))
                    .catch((e) => setError(e.message));
              }}
            >
              <summary>Uppdrag & verktyg</summary>
              <div className="ai-help">
                <pre>{help || "Läser handboken…"}</pre>
              </div>
            </details>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="error mx-5 my-3">
          {error}
        </p>
      )}
      <div
        className="chat-history"
        role={tab === "chat" ? "log" : undefined}
        aria-live={tab === "chat" ? "polite" : undefined}
      >
        {tab === "chat" && (
          <>
            {!messages.length && !current && (
              <div className="chat-empty">
                <p className="text-sm font-medium text-slate-600">
                  Vad vill du få gjort?
                </p>
                <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                  Lägg till flera uppgifter i kön. Chatten minimeras när AI:n
                  börjar utföra arbetet och öppnas om den behöver ditt svar.
                </p>
                <p className="text-xs text-slate-400 mt-3">
                  Tidigare samtal och minnen finns kvar efter omladdning.
                </p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`chat-entry ${m.role}`}>
                <div className="chat-label">
                  {m.role === "user" ? "Du" : "Assistent"} ·{" "}
                  {new Date(m.created_at).toLocaleString("sv-SE")}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {m.content}
                </p>
              </div>
            ))}
            {next !== null && (
              <button
                className="text-button"
                onClick={() => void moreMessages()}
              >
                Fler meddelanden
              </button>
            )}
            {current && (
              <p className="chat-loading" role="status">
                <span className="spinner" />
                {current.progress}
              </p>
            )}
            {pending.map((p) => (
              <div key={p.id} className="delete-confirm mt-3">
                <p className="text-sm font-medium">
                  Ta bort {p.kind === "board" ? "tavlan" : "kortet"} ”{p.name}”?
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {p.kind === "board"
                    ? "Tavlans kort, sprintar och flöden tas också bort."
                    : "Kortets flöde tas också bort."}
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    className="button small"
                    disabled={!!confirmBusy}
                    onClick={() => void approve(p.id, false)}
                  >
                    Behåll
                  </button>
                  <button
                    className="button small danger"
                    disabled={!!confirmBusy}
                    onClick={() => void approve(p.id, true)}
                  >
                    Ja, ta bort
                  </button>
                </div>
              </div>
            ))}
            <div ref={bottom} />
          </>
        )}
        {tab === "history" && (
          <>
            <form
              className="knowledge-search"
              onSubmit={(e) => {
                e.preventDefault();
                void api<{ messages: (ChatMessage & { title: string })[] }>(
                  `/api/ai/conversations?query=${encodeURIComponent(historyQuery)}`,
                )
                  .then((d) => setHits(d.messages))
                  .catch((e) => setError(e.message));
              }}
            >
              <label className="field">
                Sök tidigare samtal
                <input
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  maxLength={200}
                />
              </label>
              <button className="button small">Sök</button>
            </form>
            <button
              className="text-button mb-4"
              onClick={() => {
                setHits(null);
                setHistoryQuery("");
              }}
            >
              Visa senaste samtalen
            </button>
            {hits
              ? hits.map((m) => (
                  <button
                    className="history-card"
                    key={m.id}
                    onClick={() => openChat(m.conversation_id)}
                  >
                    <strong>{m.title}</strong>
                    <p>{m.content.slice(0, 300)}</p>
                  </button>
                ))
              : work.conversations.map((c) => (
                  <button
                    className="history-card"
                    key={c.id}
                    onClick={() => openChat(c.id)}
                  >
                    <strong>{c.title}</strong>
                    <span>
                      {new Date(c.updated_at).toLocaleString("sv-SE")}
                    </span>
                    <p>{c.summary.slice(0, 220)}</p>
                  </button>
                ))}
            {!work.conversations.length && (
              <p className="field-help">
                Dina nya samtal sparas här automatiskt.
              </p>
            )}
          </>
        )}
        {tab === "memory" && (
          <>
            <p className="field-help mb-4">
              AI:n återanvänder relevanta minnen och lärdomar. Granska källan
              och rätta eller glöm sådant som inte stämmer.
            </p>
            <form
              className="memory-form"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api("/api/ai/memories", "POST", {
                    key: memoryKey,
                    content: memoryContent,
                    kind: memoryKind,
                    board_id: memoryGlobal ? null : workspace.board.id,
                  });
                  setMemoryKey("");
                  setMemoryContent("");
                  await loadMemories();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <label className="field">
                Minnets namn
                <input
                  required
                  maxLength={120}
                  value={memoryKey}
                  onChange={(e) => setMemoryKey(e.target.value)}
                />
              </label>
              <label className="field">
                Innehåll
                <textarea
                  required
                  rows={3}
                  maxLength={2000}
                  aria-label="Innehåll"
                  value={memoryContent}
                  onChange={(e) => setMemoryContent(e.target.value)}
                />
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={memoryGlobal}
                  onChange={(e) => setMemoryGlobal(e.target.checked)}
                />
                Gäller alla tavlor
              </label>
              <button
                className="button small"
                disabled={!memoryKey.trim() || !memoryContent.trim()}
              >
                Spara minne
              </button>
            </form>
            {memories.map((m) => (
              <article className="memory-card" key={m.id}>
                <strong>{m.key}</strong>
                <span>
                  {m.kind} · {m.board_id ? "Den här tavlan" : "Globalt"} ·
                  Använt {m.uses} gånger
                </span>
                <p>{m.content}</p>
                <p className="field-help">
                  Källa:{" "}
                  {m.source === "manual"
                    ? "Du"
                    : m.source === "tool_feedback"
                      ? "Verktygsfel och loggar"
                      : "AI-tolkning av användarmeddelande"}
                </p>
                <div className="flex flex-wrap gap-3 mt-3">
                  {m.source_message_id && (
                    <button
                      className="text-button"
                      onClick={() =>
                        void api<{ message: ChatMessage }>(
                          `/api/ai/messages/${m.source_message_id}`,
                        )
                          .then((d) => openChat(d.message.conversation_id))
                          .catch((e) => setError(e.message))
                      }
                    >
                      Visa källa
                    </button>
                  )}
                  <button
                    className="text-button"
                    onClick={() => {
                      setMemoryKey(m.key);
                      setMemoryContent(m.content);
                      setMemoryGlobal(!m.board_id);
                      setMemoryKind(
                        ["preference", "fact", "decision"].includes(m.kind)
                          ? m.kind
                          : "fact",
                      );
                    }}
                  >
                    Redigera
                  </button>
                  <button
                    className="text-button danger"
                    onClick={() =>
                      void api(`/api/ai/memories/${m.id}`, "DELETE", {})
                        .then(loadMemories)
                        .catch((e) => setError(e.message))
                    }
                  >
                    Glöm
                  </button>
                </div>
              </article>
            ))}
          </>
        )}
        {tab === "logs" && (
          <>
            <form
              className="knowledge-search"
              onSubmit={(e) => {
                e.preventDefault();
                void loadLogs();
              }}
            >
              <label className="field">
                Sök i loggar
                <input
                  value={logQuery}
                  onChange={(e) => setLogQuery(e.target.value)}
                  maxLength={200}
                  placeholder="Verktyg, fel eller jobb-ID"
                />
              </label>
              <button className="button small">Sök</button>
            </form>
            <p className="field-help mb-4">
              Argument, resultat, fel och modelltider. Kända hemlighetsfält
              maskeras.
            </p>
            {logs.map((log) => (
              <details className={`log-row ${log.level}`} key={log.id}>
                <summary>
                  <span>{log.event}</span>
                  <time>
                    {new Date(log.created_at).toLocaleTimeString("sv-SE")}
                  </time>
                </summary>
                <p className="field-help">
                  {log.created_at}
                  {log.job_id && ` · Jobb ${log.job_id}`}
                </p>
                <pre>
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(log.detail), null, 2);
                    } catch {
                      return log.detail;
                    }
                  })()}
                </pre>
              </details>
            ))}
            {logNext !== null && (
              <button
                className="text-button mt-4"
                onClick={() => void loadLogs(logNext)}
              >
                Äldre loggar
              </button>
            )}
          </>
        )}
      </div>
      {tab === "chat" && (
        <form className="chat-composer" onSubmit={send}>
          {status && !status.available && (
            <p className="text-xs text-amber-800 mb-3">
              {status.message} Jobbet kan ändå läggas i kön.
            </p>
          )}
          <label className="sr-only" htmlFor="chat-input">
            Meddelande till AI-assistenten
          </label>
          <textarea
            id="chat-input"
            ref={field}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            maxLength={8000}
            placeholder="Beskriv nästa uppgift eller svara på frågan…"
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex justify-between items-center mt-2">
            <span className="composer-hint">
              Enter skickar, Skift+Enter ger ny rad
            </span>
            <button
              className="button primary small"
              disabled={sending || !input.trim()}
            >
              {sending ? "Lägger i kö…" : "Skicka"}
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}
