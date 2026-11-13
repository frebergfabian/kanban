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

export function Calendar() {
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
  const connected = accounts.some((a) => a.connected);
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
            Kalenderkonton
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
            Anslut kalenderkonto
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
        <CalendarAccounts
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

function CalendarAccounts({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]),
    [kind, setKind] = useState<"online" | "onprem">("online");
  const [name, setName] = useState(""),
    [client, setClient] = useState(""),
    [tenant, setTenant] = useState("common");
  const [endpoint, setEndpoint] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [auth, setAuth] = useState("ntlm");
  const [allow, setAllow] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [removing, setRemoving] = useState<string>();
  const load = useCallback(async () => {
    const data = await api<{ accounts: CalendarAccount[] }>(
      "/api/calendar/accounts",
    );
    setAccounts(data.accounts);
  }, []);
  useEffect(() => {
    dialog.current?.showModal();
    void load().catch((e) => setError(message(e)));
    const timer = setInterval(() => {
      void load().catch((e) => setError(message(e)));
    }, 2000);
    return () => clearInterval(timer);
  }, [load]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function permission(id: string, allow_ai: boolean) {
    const previous = accounts;
    setAccounts((current) =>
      current.map((a) => (a.id === id ? { ...a, allow_ai } : a)),
    );
    setBusy(true);
    setError("");
    try {
      await manual(`/accounts/${id}`, "PATCH", { allow_ai });
      await load();
    } catch (e) {
      setAccounts(previous);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    await action(async () => {
      const body =
        kind === "online"
          ? {
              kind,
              name,
              client_id: client.trim(),
              tenant: tenant.trim(),
              allow_ai: allow,
            }
          : {
              kind,
              name,
              endpoint: endpoint.trim(),
              username: username.trim(),
              password,
              auth,
              allow_ai: allow,
            };
      const result = await manual<{ account: CalendarAccount }>(
        "/accounts",
        "POST",
        body,
      );
      setPassword("");
      setName("");
      if (kind === "online")
        await manual(`/accounts/${result.account.id}/login`, "POST");
    });
  }
  return (
    <dialog
      ref={dialog}
      className="task-dialog calendar-dialog"
      aria-labelledby="calendar-accounts-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="calendar-dialog-header">
        <h2 id="calendar-accounts-title">Kalenderkonton</h2>
        <button
          className="icon-button"
          aria-label="Stäng kalenderkonton"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <p>
        Kontona visar varsin huvudkalender. Du kan skriva egna bokningar här.
        AI:n kan bara läsa.
      </p>
      <div className="calendar-accounts">
        {accounts.map((account) => (
          <section key={account.id} className="calendar-account-card">
            <div className="calendar-account-top">
              <strong>{account.name}</strong>
              <span>
                {account.kind === "online"
                  ? "Exchange Online"
                  : "Exchange on-prem"}{" "}
                · {account.connected ? "Ansluten" : "Väntar på inloggning"}
              </span>
            </div>
            <label className="calendar-checkbox">
              <input
                type="checkbox"
                checked={account.allow_ai}
                disabled={busy}
                onChange={(e) => void permission(account.id, e.target.checked)}
              />{" "}
              AI får läsa denna kalender
            </label>
            {account.error && (
              <p role="alert" className="error">
                {account.error}
              </p>
            )}
            {account.login && (
              <div className="calendar-login">
                <p>
                  Öppna{" "}
                  <a href={account.login.url} target="_blank" rel="noreferrer">
                    Microsofts inloggning
                  </a>{" "}
                  och ange koden:
                </p>
                <strong className="calendar-device-code">
                  {account.login.code}
                </strong>
                <p>
                  Välj rätt konto. Koden gäller till{" "}
                  {date(account.login.expires_at).toFormat("HH:mm")}.
                </p>
              </div>
            )}
            <div className="calendar-actions">
              {account.kind === "online" && !account.login && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      manual(`/accounts/${account.id}/login`, "POST"),
                    )
                  }
                >
                  {account.connected
                    ? "Förnya inloggning"
                    : "Logga in hos Microsoft"}
                </button>
              )}
              {removing === account.id ? (
                <>
                  <span>
                    Ta bort kopplingen? Händelserna finns kvar i Exchange.
                  </span>
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await manual(`/accounts/${account.id}`, "DELETE");
                        setRemoving(undefined);
                      })
                    }
                  >
                    Ja, ta bort koppling
                  </button>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => setRemoving(undefined)}
                  >
                    Avbryt
                  </button>
                </>
              ) : (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setRemoving(account.id)}
                >
                  Ta bort koppling
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
      <form className="calendar-form" onSubmit={add}>
        <h3>Lägg till konto</h3>
        <label>
          Typ
          <select
            value={kind}
            disabled={busy}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="online">Exchange Online / Microsoft 365</option>
            <option value="onprem">Exchange on-prem</option>
          </select>
        </label>
        <label>
          Kontonamn
          <input
            required
            maxLength={80}
            placeholder="Privat eller Jobb"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {kind === "online" ? (
          <>
            <label>
              Application (client) ID
              <input
                required
                value={client}
                onChange={(e) => setClient(e.target.value)}
                placeholder="Appregistreringens UUID"
              />
            </label>
            <label>
              Tenant
              <input
                required
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
              />
            </label>
            <p className="calendar-hint">
              Registrera en public client-app i Microsoft Entra med delegerad
              Calendars.ReadWrite och tillåt public client-flöden. Ingen client
              secret eller redirect-adress behövs.{" "}
              <a href="/api/calendar/guide" target="_blank">
                Visa installationsguide
              </a>
              .
            </p>
          </>
        ) : (
          <>
            <label>
              EWS-adress
              <input
                type="url"
                required
                placeholder="https://mail.foretaget.se/EWS/Exchange.asmx"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </label>
            <label>
              Användarnamn
              <input
                required
                autoComplete="username"
                placeholder="DOMÄN\användare eller användare@företag.se"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label>
              Lösenord
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              Autentisering
              <select value={auth} onChange={(e) => setAuth(e.target.value)}>
                <option value="ntlm">NTLM</option>
                <option value="basic">Basic över HTTPS (om IT tillåter)</option>
              </select>
            </label>
            <p className="calendar-hint">
              Servern behöver nå jobbets EWS, eventuellt via VPN. Certifikatet
              måste vara betrott. Inloggningen testas innan kontot sparas. Fråga
              IT om rätt EWS-adress och autentisering.
            </p>
          </>
        )}
        <label className="calendar-checkbox">
          <input
            type="checkbox"
            checked={allow}
            onChange={(e) => setAllow(e.target.checked)}
          />{" "}
          AI får läsa denna kalender
        </label>
        <p className="calendar-hint">
          Inloggningsuppgifter och Microsoft-token lagras krypterat på servern.
          Anslutningar och kalenderdata delas med dem som har tillgång till
          denna Kanban-installation.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? "Ansluter…" : "Lägg till kalenderkonto"}
        </button>
      </form>
    </dialog>
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
            Möten med deltagare och återkommande händelser läses här. Ändra dem
            i Outlook.
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
