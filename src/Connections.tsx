import { useEffect, useRef, useState } from "react";
import type { CalendarAccount } from "../shared/calendar.js";
import { api } from "./api.js";
import { Icon } from "./Icon.js";

type MicrosoftStatus = {
  configured: boolean;
  connect_url: string | null;
  message: string;
};
async function change(path: string, method: string, body: unknown = {}) {
  const response = await fetch(`/api/calendar${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Calendar-Action": "manual",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Anslutningen misslyckades.");
  return data;
}
export function Connections({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]),
    [microsoft, setMicrosoft] = useState<MicrosoftStatus>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [removing, setRemoving] = useState<string>();
  const [name, setName] = useState("Jobb"),
    [endpoint, setEndpoint] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [auth, setAuth] = useState("ntlm"),
    [allow, setAllow] = useState(true);
  async function load() {
    const [data, status] = await Promise.all([
      api<{ accounts: CalendarAccount[] }>("/api/mail/accounts"),
      api<MicrosoftStatus>("/api/microsoft/status"),
    ]);
    setAccounts(data.accounts);
    setMicrosoft(status);
  }
  useEffect(() => {
    dialog.current?.showModal();
    void load().catch((e) => setError(e.message));
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
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
      await change(`/accounts/${id}`, "PATCH", { allow_ai });
      await load();
    } catch (e) {
      setAccounts(previous);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="task-dialog calendar-dialog"
      aria-labelledby="connections-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="calendar-dialog-header">
        <h2 id="connections-title">E-post och kalender</h2>
        <button
          className="icon-button"
          aria-label="Stäng konton"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <p className="calendar-hint">
        Microsoft 365 ger läsåtkomst till e-post och kalender. Inloggning sker
        hos Microsoft.
      </p>
      {microsoft?.configured && microsoft.connect_url ? (
        <a className="button primary" href={microsoft.connect_url}>
          Anslut Microsoft-konto
        </a>
      ) : (
        <>
          <button className="button primary" disabled>
            Anslut Microsoft-konto
          </button>
          {microsoft && (
            <p role="status" className="calendar-hint">
              {microsoft.message}
            </p>
          )}
        </>
      )}
      <div className="calendar-accounts">
        {accounts.map((account) => (
          <section key={account.id} className="calendar-account-card">
            <div className="calendar-account-top">
              <strong>{account.name}</strong>
              <span>
                {account.kind === "online"
                  ? "Microsoft 365 · Endast läsning"
                  : "Exchange on-prem"}{" "}
                · {account.connected ? "Ansluten" : "Anslut igen"}
              </span>
            </div>
            <label className="calendar-checkbox">
              <input
                type="checkbox"
                checked={account.allow_ai}
                disabled={busy}
                onChange={(e) => void permission(account.id, e.target.checked)}
              />{" "}
              AI får läsa e-post och kalender
            </label>
            <div className="calendar-actions">
              {removing === account.id ? (
                <>
                  <span>
                    Ta bort kopplingen? E-post och kalender finns kvar i
                    Exchange.
                  </span>
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await change(`/accounts/${account.id}`, "DELETE");
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
      <details>
        <summary>Lägg till Exchange on-prem</summary>
        <form
          className="calendar-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await change("/accounts", "POST", {
                kind: "onprem",
                name,
                endpoint,
                username,
                password,
                auth,
                allow_ai: allow,
              });
              setPassword("");
            });
          }}
        >
          <p className="calendar-hint">
            Befintliga on-prem-konton återanvänds för e-post och kalender. Lägg
            bara till ett konto om det saknas.
          </p>
          <label>
            Kontonamn
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            EWS-adress
            <input
              required
              type="url"
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
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            Lösenord
            <input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            Autentisering
            <select value={auth} onChange={(e) => setAuth(e.target.value)}>
              <option value="ntlm">NTLM</option>
              <option value="basic">Basic över HTTPS</option>
            </select>
          </label>
          <label className="calendar-checkbox">
            <input
              type="checkbox"
              checked={allow}
              onChange={(e) => setAllow(e.target.checked)}
            />{" "}
            AI får läsa e-post och kalender
          </label>
          <button className="button" disabled={busy}>
            {busy ? "Ansluter…" : "Anslut Exchange on-prem"}
          </button>
        </form>
      </details>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p className="calendar-hint">
        Kontona delas med dem som har tillgång till denna installation. Token
        och inloggningsuppgifter lagras krypterat. Inga automatiska AI-analyser
        körs.{" "}
        <a href="/api/calendar/guide" target="_blank" rel="noreferrer">
          Installationsguide
        </a>
      </p>
    </dialog>
  );
}
