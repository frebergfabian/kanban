import { useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import type { IntegrationSync } from "../server/integration-sync.js";
import type { SyncSettings } from "../shared/sync.js";
import type { BoardInfo, ExternalContext } from "../shared/schema.js";
import type { CalendarAccount } from "../shared/calendar.js";
import { api } from "./api.js";

type Status = ReturnType<IntegrationSync["status"]>;
type Results = ReturnType<IntegrationSync["search"]>;
type Item = ReturnType<IntegrationSync["item"]>;
const labels: Record<string, string> = {
  action: "Åtgärd",
  question: "Fråga",
  meeting: "Möte",
  information: "Information",
  newsletter: "Utskick",
  spam: "Skräppost",
  queued: "I kö",
  running: "Analyserar",
  done: "Analyserad",
  review: "Behöver granskas",
  indexed: "Indexerad",
  failed: "Misslyckad",
  removed: "Källan borttagen",
  indexing: "Hämtar urval",
  analyzing: "Analyserar",
  completed: "Klar",
  partial: "Delvis klar",
  cancelled: "Avbruten",
};
const when = (date: string) =>
  DateTime.fromISO(date)
    .setZone("Europe/Stockholm")
    .setLocale("sv")
    .toFormat("d LLL HH:mm");
const editable = ({ since: _since, ...settings }: SyncSettings) => settings;
export function Sync({
  onOpenTask,
  onAsk,
}: {
  onOpenTask: (id: string) => void;
  onAsk: (context: ExternalContext) => void;
}) {
  const [status, setStatus] = useState<Status>(),
    [draft, setDraft] = useState<SyncSettings>();
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]),
    [boards, setBoards] = useState<BoardInfo[]>([]);
  const [results, setResults] = useState<Results>(),
    [item, setItem] = useState<Item>();
  const [query, setQuery] = useState(""),
    [searched, setSearched] = useState("");
  const [kind, setKind] = useState("all"),
    [category, setCategory] = useState(""),
    [minimum, setMinimum] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [mode, setMode] = useState("count"),
    [analysisKind, setAnalysisKind] = useState("mail"),
    [count, setCount] = useState(10),
    [account, setAccount] = useState("");
  const [from, setFrom] = useState(
      DateTime.now().setZone("Europe/Stockholm").startOf("week").toISODate()!,
    ),
    [to, setTo] = useState(
      DateTime.now().setZone("Europe/Stockholm").toISODate()!,
    );
  const generation = useRef(0),
    mounted = useRef(true),
    opening = useRef(0);
  async function loadStatus() {
    const next = await api<Status>("/api/sync/status");
    if (mounted.current) {
      setStatus(next);
      setDraft((old) => old ?? next.settings);
    }
  }
  async function loadIndex(offset = 0) {
    const current = ++generation.current;
    const params = new URLSearchParams({
      query: searched,
      kind,
      min_urgency: String(minimum),
      offset: String(offset),
      limit: "25",
    });
    if (category) params.set("category", category);
    const next = await api<Results>(`/api/sync/items?${params}`);
    if (mounted.current && current === generation.current)
      setResults((old) =>
        offset && old
          ? { ...next, items: [...old.items, ...next.items] }
          : next,
      );
  }
  useEffect(() => {
    mounted.current = true;
    void Promise.all([
      loadStatus(),
      api<{ accounts: CalendarAccount[] }>("/api/mail/accounts"),
      api<{ boards: BoardInfo[] }>("/api/boards"),
    ])
      .then(([, a, b]) => {
        if (mounted.current) {
          setAccounts(a.accounts);
          setBoards(b.boards);
        }
      })
      .catch((e) => mounted.current && setError(e.message));
    const timer = setInterval(() => {
      void loadStatus().catch(() => {});
    }, 5000);
    return () => {
      mounted.current = false;
      generation.current++;
      opening.current++;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    void loadIndex().catch((e) => setError(e.message));
  }, [searched, kind, category, minimum]);
  useEffect(() => {
    const selected = new URLSearchParams(
      window.location.hash.split("?")[1],
    ).get("source");
    if (selected && /^[0-9a-f-]{36}$/i.test(selected)) void open(selected);
  }, []);
  useEffect(() => {
    if (!results || results.items.length <= 25)
      void loadIndex().catch(() => {});
  }, [status]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await loadStatus();
      await loadIndex();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function open(id: string) {
    const current = ++opening.current;
    try {
      const result = await api<{ item: Item }>(`/api/sync/items/${id}`);
      if (mounted.current && current === opening.current) setItem(result.item);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const total = status?.counts.reduce((n, x) => n + x.count, 0) ?? 0;
  const waiting =
    status?.counts
      .filter((x) => ["queued", "running"].includes(x.status))
      .reduce((n, x) => n + x.count, 0) ?? 0;
  const failed = status?.counts.find((x) => x.status === "failed")?.count ?? 0;
  return (
    <section className="sync-page" aria-label="Synk och analys">
      <div className="calendar-heading">
        <div>
          <h1>Synk och analys</h1>
          <p>E-post och kalender → Kanban</p>
        </div>
        <div className="sync-actions">
          <button
            className="button"
            disabled={busy || !status}
            onClick={() =>
              void action(() => api("/api/sync/refresh", "POST", {}))
            }
          >
            Synka nu
          </button>
          <button
            className="button"
            disabled={busy || !status}
            onClick={() =>
              void action(() =>
                api("/api/sync/settings", "PUT", {
                  ...editable(status!.settings),
                  enabled: !status!.settings.enabled,
                }),
              )
            }
          >
            {status?.settings.enabled ? "Pausa synk" : "Aktivera synk"}
          </button>
        </div>
      </div>
      <p role="status" className="sync-status">
        {status?.settings.enabled
          ? "Automatisk synk aktiv"
          : "Automatisk synk pausad"}{" "}
        · {total} indexerade · {waiting} i kö
        {failed ? ` · ${failed} misslyckade` : ""}
        {status?.analyzing ? " · AI arbetar" : ""}
      </p>
      <p className="calendar-hint">
        Första mejlsynken färdigställer mappindexet innan AI:n börjar.
        Kalenderfönstret är {status?.settings.initial_days ?? 30} dagar bakåt
        och {status?.settings.calendar_future_days ?? 90} dagar framåt. Läsning
        och analys fortsätter när sidan är stängd.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!!status?.errors.length && (
        <div className="error" role="alert">
          {status.errors.map((e, i) => (
            <p key={i}>
              {accounts.find((a) => a.id === e.account_id)?.name || "Konto"}:{" "}
              {e.last_error}
            </p>
          ))}
        </div>
      )}
      {draft && (
        <details className="sync-settings">
          <summary>Inställningar</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const next = await api<Status>(
                  "/api/sync/settings",
                  "PUT",
                  editable(draft),
                );
                setDraft(next.settings);
                setMessage("Inställningarna är sparade.");
              });
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />{" "}
              Automatisk analys och uppdatering av Kanban
            </label>
            <label>
              Nya kort på tavla
              <select
                value={draft.board_id}
                onChange={(e) =>
                  setDraft({ ...draft, board_id: e.target.value })
                }
              >
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mejlhistorik vid start (dagar)
              <input
                type="number"
                min="1"
                max="365"
                required
                value={draft.initial_days}
                onChange={(e) =>
                  setDraft({ ...draft, initial_days: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Synkintervall (sekunder)
              <input
                type="number"
                min="60"
                max="3600"
                required
                value={draft.interval_seconds}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    interval_seconds: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Kalender framåt (dagar)
              <input
                type="number"
                min="1"
                max="365"
                required
                value={draft.calendar_future_days}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    calendar_future_days: Number(e.target.value),
                  })
                }
              />
            </label>
            <fieldset>
              <legend>Konton</legend>
              {accounts.map((a) => (
                <label key={a.id}>
                  <input
                    type="checkbox"
                    disabled={!a.connected || !a.allow_ai}
                    checked={draft.account_ids.includes(a.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        account_ids: e.target.checked
                          ? [...draft.account_ids, a.id]
                          : draft.account_ids.filter((id) => id !== a.id),
                      })
                    }
                  />
                  {a.name}
                  {!a.allow_ai
                    ? " (AI-läsning avstängd)"
                    : !a.connected
                      ? " (anslut igen)"
                      : ""}
                </label>
              ))}
            </fieldset>
            <button className="button primary" disabled={busy}>
              Spara inställningar
            </button>
          </form>
        </details>
      )}
      <details className="sync-settings">
        <summary>Analysera ett urval</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const request = {
                kind: analysisKind,
                ...(account ? { account_ids: [account] } : {}),
                ...(mode === "count"
                  ? { limit: count }
                  : {
                      from: DateTime.fromISO(from, { zone: "Europe/Stockholm" })
                        .startOf("day")
                        .toISO(),
                      to: DateTime.fromISO(to, { zone: "Europe/Stockholm" })
                        .plus({ days: 1 })
                        .startOf("day")
                        .toISO(),
                    }),
              };
              await api("/api/sync/runs", "POST", request);
              setMessage("Analysen har köats. Följ körningen nedan.");
            });
          }}
        >
          <label>
            Typ av analys
            <select
              value={analysisKind}
              onChange={(e) => setAnalysisKind(e.target.value)}
            >
              <option value="mail">Mejl</option>
              <option value="calendar">Kalender</option>
            </select>
          </label>
          <label>
            Konto
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">Alla AI-tillåtna konton</option>
              {accounts
                .filter((a) => a.allow_ai && a.connected)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Urval
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="count">Senaste antal</option>
              <option value="dates">Datumintervall</option>
            </select>
          </label>
          {mode === "count" ? (
            <label>
              Antal
              <input
                type="number"
                required
                min="1"
                max="10000"
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </label>
          ) : (
            <>
              <label>
                Från
                <input
                  type="date"
                  required
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                Till och med
                <input
                  type="date"
                  required
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </>
          )}
          <p className="calendar-hint">
            Analyserar{" "}
            {analysisKind === "calendar" ? "kalenderobjekt" : "mottagna mejl"}.
            Resultatet kan skapa eller uppdatera Kanban-kort. Du kan också be
            AI:n: ”analysera mina 10 senaste mail” eller ”analysera mina mail
            från den här veckan”.
          </p>
          <button className="button" disabled={busy}>
            Köa analys
          </button>
        </form>
      </details>
      {!!status?.runs.length && (
        <details className="sync-settings" open>
          <summary>Senaste analyser</summary>
          <div className="sync-runs">
            {status.runs.map((run) => (
              <div key={run.id}>
                <span>
                  {when(run.created_at)} · {labels[run.status] || run.status} ·{" "}
                  {run.counts.reduce((n, x) => n + x.count, 0)} källor
                </span>
                {["indexing", "analyzing"].includes(run.status) && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        api(`/api/sync/runs/${run.id}/cancel`, "POST", {}),
                      )
                    }
                  >
                    Avbryt
                  </button>
                )}
                {run.last_error && (
                  <span className="error">{run.last_error}</span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      <form
        className="mail-toolbar sync-filters"
        onSubmit={(e) => {
          e.preventDefault();
          if (query === searched) void action(() => loadIndex());
          else setSearched(query);
        }}
      >
        <input
          aria-label="Sök index"
          type="search"
          placeholder="Sök i index…"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Typ av källa"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="all">Mejl och kalender</option>
          <option value="mail">Mejl</option>
          <option value="calendar">Kalender</option>
        </select>
        <select
          aria-label="Kategori"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Alla kategorier</option>
          {[
            "action",
            "question",
            "meeting",
            "information",
            "newsletter",
            "spam",
          ].map((c) => (
            <option key={c} value={c}>
              {labels[c]}
            </option>
          ))}
        </select>
        <label>
          Min urgency
          <input
            aria-label="Minsta urgency"
            type="number"
            min="0"
            max="100"
            value={minimum}
            onChange={(e) => setMinimum(Number(e.target.value))}
          />
        </label>
        <button className="button" disabled={busy}>
          Sök / uppdatera
        </button>
      </form>
      <div className={`mail-layout ${item ? "has-detail" : ""}`}>
        <div className="mail-list" aria-label="Indexerade källor">
          {results?.items.map((source) => (
            <button
              key={source.id}
              className={`mail-row ${source.id === item?.id ? "selected" : ""}`}
              onClick={() => void open(source.id)}
            >
              <span className="mail-row-head">
                <span>
                  {source.document.kind === "calendar" ? "Kalender" : "Mejl"} ·{" "}
                  {source.document.sender}
                </span>
                <time>{when(source.document.occurred_at)}</time>
              </span>
              <strong>{source.document.title}</strong>
              <span className="sync-item-meta">
                <span
                  className={`urgency-score ${Number(source.analysis?.urgency) >= 75 ? "urgent" : ""}`}
                >
                  {source.analysis
                    ? `${source.analysis.urgency}%`
                    : "Ej analyserad"}
                </span>
                <span>{labels[source.analysis?.category || ""]}</span>
                <span>{labels[source.status] || source.status}</span>
                {source.task_id && <span>Kopplat kort</span>}
              </span>
              {source.analysis && (
                <span className="mail-preview">{source.analysis.summary}</span>
              )}
            </button>
          ))}
          {results && !results.items.length && (
            <p className="calendar-empty">
              Inga indexerade källor matchar filtret.
            </p>
          )}
          {results?.next_offset != null && (
            <button
              className="button mail-more"
              onClick={() =>
                void loadIndex(results.next_offset!).catch((e) =>
                  setError(e.message),
                )
              }
            >
              Visa fler
            </button>
          )}
        </div>
        {item && (
          <article className="mail-detail" aria-label="Källanalys">
            <button className="text-button" onClick={() => setItem(undefined)}>
              Stäng
            </button>
            <h2>{item.document.title}</h2>
            <p>
              {item.analysis
                ? `${item.analysis.urgency}% · ${labels[item.analysis.category]}`
                : labels[item.status]}{" "}
              · {when(item.document.occurred_at)}
            </p>
            {item.last_error && <p className="error">{item.last_error}</p>}
            {item.status === "review" && (
              <p className="calendar-hint">
                Bedömningen är osäker eller matchningen behöver granskas. Inget
                automatiskt kort skapades av detta underlag.
              </p>
            )}
            {item.analysis && (
              <>
                <p>{item.analysis.summary}</p>
                {item.analysis.action_details && (
                  <>
                    <h3>Föreslagna nästa steg</h3>
                    <p className="sync-text">{item.analysis.action_details}</p>
                  </>
                )}
                {item.analysis.evidence && (
                  <blockquote>{item.analysis.evidence}</blockquote>
                )}
              </>
            )}
            <div className="sync-actions">
              {item.task_id && (
                <button
                  className="button"
                  onClick={() => onOpenTask(item.task_id!)}
                >
                  Öppna Kanban-kort
                </button>
              )}
              <button
                className="button"
                onClick={() =>
                  onAsk({
                    kind: item.document.kind,
                    account_id: item.account_id,
                    item_id: item.document.external_id,
                  })
                }
              >
                Fråga AI om källan
              </button>
            </div>
            <p className="calendar-hint">
              {item.document.folder} · {item.document.sender}
            </p>
            <details>
              <summary>Källtext</summary>
              <pre className="mail-body">{item.document.body}</pre>
              {item.document.body_truncated && <p>Brödtexten är förkortad.</p>}
            </details>
            <small>Indexreferens: {item.id}</small>
          </article>
        )}
      </div>
    </section>
  );
}
