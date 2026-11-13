import { useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import type { CalendarAccount } from "../shared/calendar.js";
import type { MailDetail, MailPage } from "../shared/mail.js";
import { api } from "./api.js";
import { Connections } from "./Connections.js";
import type { ExternalContext } from "../shared/schema.js";

const when = (value: string) => {
  const date = DateTime.fromISO(value)
    .setZone("Europe/Stockholm")
    .setLocale("sv");
  return date.isValid ? date.toFormat("d LLL yyyy HH:mm") : "Okänt datum";
};
export function Mail({
  onSelection,
}: {
  onSelection: (context?: ExternalContext) => void;
}) {
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]),
    [account, setAccount] = useState("");
  const [settings, setSettings] = useState(false),
    [query, setQuery] = useState(""),
    [searched, setSearched] = useState(""),
    [folder, setFolder] = useState("inbox");
  const [page, setPage] = useState<MailPage>(),
    [detail, setDetail] = useState<MailDetail>(),
    [busy, setBusy] = useState(false),
    [opening, setOpening] = useState(false),
    [error, setError] = useState("");
  const [scores, setScores] = useState<
    Record<
      string,
      {
        id: string;
        urgency: number | null;
        category: string | null;
        status: string;
      }
    >
  >({});
  const request = useRef(0),
    detailRequest = useRef(0),
    mounted = useRef(true);
  const [authStatus] = useState(() =>
    new URLSearchParams(window.location.hash.split("?")[1]).get("microsoft"),
  );
  useEffect(() => {
    onSelection(
      detail
        ? { kind: "mail", account_id: detail.account_id, item_id: detail.id }
        : undefined,
    );
  }, [detail, onSelection]);
  useEffect(() => () => onSelection(undefined), [onSelection]);
  async function loadAccounts() {
    try {
      const { accounts: current } = await api<{ accounts: CalendarAccount[] }>(
        "/api/mail/accounts",
      );
      if (!mounted.current) return;
      setAccounts(current);
      setAccount((previous) =>
        current.some((a) => a.id === previous)
          ? previous
          : (current.find((a) => a.connected)?.id ?? current[0]?.id ?? ""),
      );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void loadAccounts();
    return () => {
      mounted.current = false;
      request.current++;
      detailRequest.current++;
    };
  }, []);
  async function search(offset = 0) {
    if (!account) return;
    const generation = ++request.current;
    setBusy(true);
    setError("");
    try {
      const result = await api<MailPage>(
        `/api/mail/messages?${new URLSearchParams({ account_id: account, folder, query: searched, offset: String(offset), limit: "25" })}`,
      );
      if (generation === request.current)
        setPage((previous) =>
          offset && previous
            ? {
                ...result,
                messages: [...previous.messages, ...result.messages],
              }
            : result,
        );
      void api<{
        items: {
          external_id: string;
          index: {
            id: string;
            urgency: number | null;
            category: string | null;
            status: string;
          } | null;
        }[];
      }>("/api/sync/lookup", "POST", {
        account_id: account,
        ids: result.messages.map((m) => m.id),
      })
        .then((lookup) => {
          if (generation === request.current)
            setScores((old) => ({
              ...old,
              ...Object.fromEntries(
                lookup.items
                  .filter((x) => x.index)
                  .map((x) => [x.external_id, x.index!]),
              ),
            }));
        })
        .catch(() => {});
    } catch (e) {
      if (generation === request.current) setError((e as Error).message);
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    setPage(undefined);
    setDetail(undefined);
    detailRequest.current++;
    setOpening(false);
    void search();
    return () => {
      request.current++;
    };
  }, [account, searched, folder]);
  async function open(id: string) {
    const generation = ++detailRequest.current;
    setOpening(true);
    setError("");
    try {
      const result = await api<{ message: MailDetail }>(
        `/api/mail/accounts/${account}/messages/${encodeURIComponent(id)}`,
      );
      if (generation === detailRequest.current) setDetail(result.message);
    } catch (e) {
      if (generation === detailRequest.current) setError((e as Error).message);
    } finally {
      if (generation === detailRequest.current) setOpening(false);
    }
  }
  return (
    <section className="mail-page" aria-label="E-post">
      <div className="calendar-heading">
        <div>
          <h1>E-post</h1>
          <p>
            Endast läsning · <a href="#sync">Synk och analys</a>
          </p>
        </div>
        <button className="button" onClick={() => setSettings(true)}>
          Konton
        </button>
      </div>
      {authStatus === "connected" && (
        <p role="status" className="calendar-hint">
          Microsoft-kontot är anslutet för e-post och kalender.
        </p>
      )}
      {authStatus === "failed" && (
        <p role="alert" className="error">
          Microsoft-inloggningen kunde inte slutföras. Öppna Konton och försök
          igen.
        </p>
      )}
      <form
        className="mail-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (query === searched) void search();
          else setSearched(query);
        }}
      >
        <label className="sr-only" htmlFor="mail-account">
          E-postkonto
        </label>
        <select
          id="mail-account"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="" disabled>
            Välj konto
          </option>
          {accounts.map((a) => (
            <option value={a.id} key={a.id}>
              {a.name}
              {a.connected ? "" : " (anslut igen)"}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="mail-folder">
          Mapp
        </label>
        <select
          id="mail-folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        >
          <option value="inbox">Inkorg</option>
          <option value="sent">Skickat</option>
        </select>
        <label className="sr-only" htmlFor="mail-search">
          Sök e-post
        </label>
        <input
          id="mail-search"
          type="search"
          maxLength={200}
          value={query}
          placeholder="Sök e-post…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="button" disabled={!account || busy}>
          Sök
        </button>
        <button
          className="button"
          type="button"
          disabled={!account || busy}
          onClick={() => void search()}
        >
          Uppdatera
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {busy && <p role="status">Läser e-post…</p>}
      {opening && <p role="status">Öppnar mejlet…</p>}
      {!accounts.length && (
        <div className="calendar-empty">
          <h2>Anslut e-post och kalender</h2>
          <p>
            Använd Microsoft 365 eller din befintliga Exchange
            on-prem-anslutning.
          </p>
          <button className="button primary" onClick={() => setSettings(true)}>
            Anslut konto
          </button>
        </div>
      )}
      {!!accounts.length && (
        <div className={`mail-layout ${detail ? "has-detail" : ""}`}>
          <div className="mail-list" aria-label="Mejllista">
            {page?.messages.map((item) => (
              <button
                className={`mail-row ${detail?.id === item.id ? "selected" : ""} ${item.is_read ? "" : "unread"}`}
                key={item.id}
                onClick={() => void open(item.id)}
                aria-label={`Öppna mejl ${item.subject}`}
              >
                <span className="mail-row-head">
                  <span>
                    {item.from.name || item.from.address || "Okänd avsändare"}
                  </span>
                  <time>{when(item.received_at)}</time>
                </span>
                <strong>{item.subject}</strong>
                {scores[item.id] && (
                  <span className="sync-item-meta">
                    <span
                      className={`urgency-score ${Number(scores[item.id].urgency) >= 75 ? "urgent" : ""}`}
                    >
                      {scores[item.id].urgency == null
                        ? "Ej analyserad"
                        : `${scores[item.id].urgency}%`}
                    </span>
                    <span>
                      {
                        (
                          {
                            action: "Åtgärd",
                            question: "Fråga",
                            meeting: "Möte",
                            information: "Information",
                            newsletter: "Utskick",
                            spam: "Skräppost",
                          } as Record<string, string>
                        )[scores[item.id].category || ""]
                      }
                    </span>
                  </span>
                )}
                {item.preview && (
                  <span className="mail-preview">{item.preview}</span>
                )}
                {item.has_attachments && (
                  <span className="calendar-hint">Har bilagor</span>
                )}
              </button>
            ))}
            {!busy && page && !page.messages.length && (
              <p className="calendar-empty">
                {searched
                  ? "Inga mejl matchade sökningen i vald mapp."
                  : "Inga mejl i vald mapp."}
              </p>
            )}
            {page?.next_offset != null && (
              <button
                className="button mail-more"
                disabled={busy}
                onClick={() => void search(page.next_offset!)}
              >
                Visa fler
              </button>
            )}
          </div>
          {detail ? (
            <article className="mail-detail" aria-label="Mejlinnehåll">
              {scores[detail.id] && (
                <a
                  className="text-button"
                  href={`#sync?source=${scores[detail.id].id}`}
                >
                  Visa analys och kopplat Kanban-kort
                </a>
              )}
              <button
                className="text-button"
                onClick={() => {
                  detailRequest.current++;
                  setDetail(undefined);
                }}
              >
                ← Till mejllistan
              </button>
              <h2>{detail.subject}</h2>
              <dl>
                <dt>Från</dt>
                <dd>
                  {detail.from.name}{" "}
                  {detail.from.address && `<${detail.from.address}>`}
                </dd>
                <dt>Till</dt>
                <dd>
                  {detail.to.map((x) => x.address || x.name).join(", ") || "—"}
                </dd>
                {!!detail.cc.length && (
                  <>
                    <dt>Kopia</dt>
                    <dd>
                      {detail.cc.map((x) => x.address || x.name).join(", ")}
                    </dd>
                  </>
                )}
                <dt>Datum</dt>
                <dd>{when(detail.received_at)}</dd>
              </dl>
              <div className="mail-body">
                {detail.body || "Mejlet saknar textinnehåll."}
              </div>
              {detail.body_truncated && (
                <p role="status" className="calendar-hint">
                  Texten är förkortad. Läs hela mejlet i Outlook.
                </p>
              )}
              <p className="calendar-hint">
                Mejlet markeras inte som läst. Bilagor och externt innehåll
                hämtas inte.
              </p>
            </article>
          ) : (
            <div className="mail-detail mail-placeholder">
              Välj ett mejl för att läsa det.
            </div>
          )}
        </div>
      )}
      {settings && (
        <Connections
          onClose={() => {
            setSettings(false);
            void loadAccounts();
          }}
        />
      )}
    </section>
  );
}
