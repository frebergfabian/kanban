import { useCallback, useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import type {
  CalendarAccount,
  CalendarDraft,
  CalendarEvent,
  CalendarResult,
} from "../shared/calendar.js";
import { api } from "./api.js";
import { Icon } from "./Icon.js";
import { Connections } from "./Connections.js";
import type { ExternalContext } from "../shared/schema.js";

const zone = "Europe/Stockholm";
const now = () => DateTime.now().setZone(zone);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Kalendern kunde inte läsas.";
async function manual<T>(
  path: string,
  method: string,
  body: unknown = {},
): Promise<T> {
  const response = await fetch(`/api/calendar${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Calendar-Action": "manual",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? "Kalenderändringen misslyckades.");
  return data;
}
const pathFor = (event: CalendarEvent) =>
  `/accounts/${event.account_id}/events/${encodeURIComponent(event.id)}`;
const date = (value: string) => DateTime.fromISO(value, { zone });
const localInput = (value: string, allDay: boolean) =>
  allDay ? value : date(value).toFormat("yyyy-MM-dd'T'HH:mm");
function onDay(event: CalendarEvent, day: DateTime) {
  return (
    date(event.start).toMillis() < day.plus({ days: 1 }).toMillis() &&
    date(event.end).toMillis() > day.toMillis()
  );
}

export function Calendar({
  onSelection,
}: {
  onSelection: (context?: ExternalContext) => void;
}) {
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]),
    [selected, setSelected] = useState("");
  const [anchor, setAnchor] = useState(() => now().startOf("month"));
  const [view, setView] = useState<"month" | "agenda">(() =>
    window.innerWidth < 768 ? "agenda" : "month",
  );
  const [result, setResult] = useState<CalendarResult>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(false),
    [opening, setOpening] = useState(false);
  const [editor, setEditor] = useState<{
    event?: CalendarEvent;
    day?: string;
  }>();
  const generation = useRef(0);
  useEffect(() => {
    if (editor?.event)
      onSelection({
        kind: "calendar",
        account_id: editor.event.account_id,
        item_id: editor.event.id,
      });
  }, [editor, onSelection]);
  useEffect(() => () => onSelection(undefined), [onSelection]);
  const load = useCallback(
    async (quiet = false) => {
      const request = ++generation.current;
      if (!quiet) setLoading(true);
      try {
        const { accounts: current } = await api<{
          accounts: CalendarAccount[];
        }>("/api/calendar/accounts");
        const start = anchor.startOf("week"),
          end = anchor.endOf("month").endOf("week").plus({ milliseconds: 1 });
        const data = await api<CalendarResult>(
          `/api/calendar/events?${new URLSearchParams({ start: start.toISO()!, end: end.toISO()!, ...(selected ? { account_id: selected } : {}) })}`,
        );
        if (request === generation.current) {
          setAccounts(current);
          setResult(data);
          setError("");
        }
      } catch (error) {
        if (request === generation.current) setError(message(error));
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [anchor, selected],
  );
  useEffect(() => {
    setResult(undefined);
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load(true);
    }, 60000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [load]);
  async function open(event: CalendarEvent) {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      const detail = await api<{ event: CalendarEvent }>(
        `/api/calendar${pathFor(event)}`,
      );
      setEditor({ event: detail.event });
    } catch (error) {
      setError(message(error));
    } finally {
      setOpening(false);
    }
  }
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const events = result?.events ?? [],
    start = anchor.startOf("week");
  const days = Array.from(
    {
      length: Math.round(
        anchor.endOf("month").endOf("week").diff(start, "days").days,
      ),
    },
    (_, i) => start.plus({ days: i }),
  );
  const monthDays = days.filter((d) => d.month === anchor.month);
  const connected = accounts.some(
    (a) =>
      a.connected && a.kind === "onprem" && (!selected || a.id === selected),
  );
  function eventButton(event: CalendarEvent, compact = false) {
    return (
      <button
        key={event.id + event.account_id}
        className={`calendar-event ${compact ? "compact" : ""}`}
        disabled={opening}
        onClick={() => void open(event)}
        title={`${names.get(event.account_id)} · ${event.title}`}
      >
        <span
          className={`calendar-account-dot ${accounts.find((a) => a.id === event.account_id)?.kind === "onprem" ? "work" : ""}`}
        />
        <span className="calendar-event-time">
          {event.all_day ? "Heldag" : date(event.start).toFormat("HH:mm")}
        </span>
        <span className="calendar-event-title">{event.title}</span>
        {!compact && (
          <span className="calendar-account-name">
            {names.get(event.account_id)}
          </span>
        )}
      </button>
    );
  }
  return (
    <section className="calendar-page" aria-label="Kalender">
      <div className="calendar-heading">
        <div>
          <h1>Kalender</h1>
          <p>Jobb och privat · Stockholm · AI har endast läsåtkomst</p>
        </div>
        <div className="calendar-actions">
          <button className="button" onClick={() => setSettings(true)}>
            Konton
          </button>
          <button
            className="button primary"
            disabled={!connected}
            onClick={() => setEditor({})}
          >
            <Icon name="plus" size={16} /> Ny händelse
          </button>
        </div>
      </div>
      <div className="calendar-toolbar">
        <div className="calendar-pager">
          <button
            className="icon-button"
            aria-label="Föregående månad"
            onClick={() => setAnchor((a) => a.minus({ months: 1 }))}
          >
            ‹
          </button>
          <h2>{anchor.setLocale("sv").toFormat("LLLL yyyy")}</h2>
          <button
            className="icon-button"
            aria-label="Nästa månad"
            onClick={() => setAnchor((a) => a.plus({ months: 1 }))}
          >
            ›
          </button>
          <button
            className="button"
            onClick={() => setAnchor(now().startOf("month"))}
          >
            Idag
          </button>
        </div>
        <div className="calendar-actions">
          <label className="sr-only" htmlFor="calendar-account-filter">
            Visa kalenderkonto
          </label>
          <select
            id="calendar-account-filter"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Alla konton</option>
            {accounts.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <div className="calendar-view-buttons" aria-label="Kalendervy">
            <button
              className={`button ${view === "month" ? "active" : ""}`}
              aria-pressed={view === "month"}
              onClick={() => setView("month")}
            >
              Månad
            </button>
            <button
              className={`button ${view === "agenda" ? "active" : ""}`}
              aria-pressed={view === "agenda"}
              onClick={() => setView("agenda")}
            >
              Agenda
            </button>
          </div>
          <button
            className="button"
            disabled={loading}
            onClick={() => void load()}
          >
            Uppdatera
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result?.errors.map((e) => (
        <p className="error" role="alert" key={e.account_id}>
          {names.get(e.account_id)}: {e.message}
        </p>
      ))}
      {result?.truncated && (
        <p role="status" className="error">
          Exchange begränsade resultatet. Alla händelser visas inte.
        </p>
      )}
      {loading && <p role="status">Läser kalendern…</p>}
      {!loading && !accounts.length && (
        <div className="calendar-empty">
          <Icon name="calendar" size={32} />
          <h2>Anslut dina kalendrar</h2>
          <p>
            Lägg till din privata Exchange Online-kalender och jobbets
            Exchange-server.
          </p>
          <button className="button primary" onClick={() => setSettings(true)}>
            Anslut konto
          </button>
        </div>
      )}
      {!!accounts.length && view === "month" && (
        <div className="calendar-grid" aria-label="Månadskalender">
          {["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"].map((d) => (
            <div className="calendar-weekday" key={d}>
              {d}
            </div>
          ))}
          {days.map((day) => (
            <div
              key={day.toISODate()}
              className={`calendar-day ${day.month !== anchor.month ? "outside" : ""} ${day.hasSame(now(), "day") ? "today" : ""}`}
            >
              <button
                className="calendar-day-number"
                disabled={!connected}
                aria-label={`Ny händelse ${day.toISODate()}`}
                onClick={() => setEditor({ day: day.toISODate()! })}
              >
                {day.day}
              </button>
              {events
                .filter((e) => onDay(e, day))
                .map((e) => eventButton(e, true))}
            </div>
          ))}
        </div>
      )}
      {!!accounts.length && view === "agenda" && (
        <div className="calendar-agenda">
          {monthDays
            .filter((d) => events.some((e) => onDay(e, d)))
            .map((day) => (
              <section key={day.toISODate()} className="calendar-agenda-day">
                <h3>{day.setLocale("sv").toFormat("ccc d LLL")}</h3>
                <div>
                  {events
                    .filter((e) => onDay(e, day))
                    .map((e) => eventButton(e))}
                </div>
              </section>
            ))}
          {!events.some((e) => monthDays.some((d) => onDay(e, d))) &&
            !loading && (
              <p className="calendar-empty">
                {result?.errors.length
                  ? "Kalendern kunde inte läsas fullständigt. Se anslutningsfelen ovan."
                  : "Inga händelser denna månad."}
              </p>
            )}
        </div>
      )}
      {result && (
        <p className="calendar-updated">
          Senast läst {date(result.fetched_at).toFormat("HH:mm:ss")} ·
          Uppdateras varje minut när sidan är synlig
        </p>
      )}
      {settings && (
        <Connections
          onClose={() => {
            setSettings(false);
            setSelected("");
            void load();
          }}
        />
      )}
      {editor && (
        <EventDialog
          accounts={accounts.filter((a) => a.connected)}
          event={editor.event}
          day={editor.day}
          accountId={selected}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            void load();
          }}
        />
      )}
    </section>
  );
}

function EventDialog({
  accounts,
  event,
  day,
  accountId,
  onClose,
  onSaved,
}: {
  accounts: CalendarAccount[];
  event?: CalendarEvent;
  day?: string;
  accountId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  accounts = event ? accounts : accounts.filter((a) => a.kind === "onprem");
  const dialog = useRef<HTMLDialogElement>(null),
    initial = day
      ? date(day).set({ hour: 9 })
      : now().plus({ hours: 1 }).startOf("hour");
  const [account, setAccount] = useState(event?.account_id ?? accountId ?? ""),
    [title, setTitle] = useState(event?.title ?? ""),
    [body, setBody] = useState(event?.description ?? ""),
    [location, setLocation] = useState(event?.location ?? "");
  const [allDay, setAllDay] = useState(event?.all_day ?? false),
    [start, setStart] = useState(
      event
        ? localInput(event.start, event.all_day)
        : initial.toFormat("yyyy-MM-dd'T'HH:mm"),
    ),
    [end, setEnd] = useState(
      event
        ? localInput(event.end, event.all_day)
        : initial.plus({ hours: 1 }).toFormat("yyyy-MM-dd'T'HH:mm"),
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  function toggleAllDay(value: boolean) {
    setAllDay(value);
    setStart(value ? start.slice(0, 10) : `${start}T09:00`);
    setEnd(
      value
        ? date(end.slice(0, 10)).plus({ days: 1 }).toISODate()!
        : `${end}T10:00`,
    );
  }
  const readOnly = event?.read_only ?? false;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (
        !allDay &&
        [start, end].some(
          (value) =>
            !date(value).isValid ||
            date(value).toFormat("yyyy-MM-dd'T'HH:mm") !== value,
        )
      )
        throw new Error(
          "Ogiltigt klockslag i Stockholm, exempelvis under övergången till sommartid. Välj en annan tid.",
        );
      const draft: CalendarDraft = {
        title,
        description: body,
        location,
        all_day: allDay,
        start: allDay ? start : date(start).toUTC().toISO()!,
        end: allDay ? end : date(end).toUTC().toISO()!,
      };
      if (event)
        await manual(pathFor(event), "PATCH", {
          event: draft,
          version: event.version,
        });
      else
        await manual(
          `/accounts/${account || accounts[0]?.id}/events`,
          "POST",
          draft,
        );
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!event) return;
    setBusy(true);
    setError("");
    try {
      await manual(pathFor(event), "DELETE", { version: event.version });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const outlook =
    event?.url &&
    /^https:\/\/(outlook\.office(365)?\.com|outlook\.live\.com)\//i.test(
      event.url,
    )
      ? event.url
      : null;
  return (
    <dialog
      ref={dialog}
      className="task-dialog calendar-dialog"
      aria-labelledby="calendar-event-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form className="calendar-form" onSubmit={save}>
        <header className="calendar-dialog-header">
          <h2 id="calendar-event-title">
            {event ? "Kalenderhändelse" : "Ny kalenderhändelse"}
          </h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Stäng händelse"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {readOnly && (
          <p className="calendar-hint">
            {accounts.find((a) => a.id === event?.account_id)?.kind === "online"
              ? "Microsoft 365-kalendern är skrivskyddad. Ändra händelsen i Outlook."
              : "Möten med deltagare och återkommande händelser läses här. Ändra dem i Outlook."}
            {outlook && (
              <>
                {" "}
                <a href={outlook} target="_blank" rel="noreferrer">
                  Öppna i Outlook
                </a>
              </>
            )}
          </p>
        )}
        <fieldset disabled={busy || readOnly} className="calendar-form">
          <label>
            Kalenderkonto
            <select
              required
              value={account || accounts[0]?.id || ""}
              disabled={!!event}
              onChange={(e) => setAccount(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rubrik
            <input
              autoFocus
              required
              maxLength={250}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="calendar-checkbox">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => toggleAllDay(e.target.checked)}
            />{" "}
            Heldag
          </label>
          <div className="calendar-date-fields">
            <label>
              Start
              <input
                required
                type={allDay ? "date" : "datetime-local"}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              {allDay ? "Slut (första dagen efter)" : "Slut"}
              <input
                required
                type={allDay ? "date" : "datetime-local"}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <label>
            Plats
            <input
              maxLength={500}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
          <label>
            Beskrivning
            <textarea
              rows={5}
              maxLength={10000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        </fieldset>
        {!!event?.attendees.length && (
          <p>Deltagare: {event.attendees.join(", ")}</p>
        )}
        <p className="calendar-hint">
          Tider anges i Europe/Stockholm. Sparas direkt i valt Exchange-konto.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!readOnly && (
          <div className="calendar-actions">
            {deleting ? (
              <>
                <p>Ta bort bokningen från Exchange?</p>
                <button
                  className="button danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  Ja, radera händelsen
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => setDeleting(false)}
                >
                  Avbryt radering
                </button>
              </>
            ) : (
              <>
                <button
                  className="button primary"
                  disabled={busy || !accounts.length}
                >
                  {busy ? "Sparar…" : "Spara i Exchange"}
                </button>
                {event && (
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    onClick={() => setDeleting(true)}
                  >
                    Radera händelse
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </form>
    </dialog>
  );
}
