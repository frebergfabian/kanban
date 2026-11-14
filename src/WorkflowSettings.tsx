import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { Workflow } from "../server/workflow.js";
type Data = {
  ignored: ReturnType<Workflow["ignores"]>;
  feedback: ReturnType<Workflow["feedbackList"]>;
};
export function WorkflowSettings() {
  const [data, setData] = useState<Data>(),
    [sender, setSender] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () => api<Data>("/api/sync/workflow").then(setData);
  useEffect(() => {
    void load().catch(() => setError("Kunde inte läsa reglerna."));
  }, []);
  async function edit(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      setSender("");
      setReason("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="workflow-settings">
      <summary>
        Ignore-lista och AI-feedback{" "}
        {data ? `· ${data.ignored.length} avsändare` : ""}
      </summary>
      <p>
        Mejl från dessa adresser analyseras aldrig, varken automatiskt eller på
        begäran. Du kan också be AI:n hantera listan i chatten.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className="ignore-form"
        onSubmit={(e) => {
          e.preventDefault();
          void edit(() => api("/api/sync/ignore", "POST", { sender, reason }));
        }}
      >
        <label>
          Avsändare
          <input
            type="email"
            required
            maxLength={320}
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            placeholder="namn@exempel.se"
          />
        </label>
        <label>
          Orsak
          <input
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Valfri förklaring"
          />
        </label>
        <button className="button" disabled={busy}>
          Ignorera avsändare
        </button>
      </form>
      <ul className="ignore-list">
        {data?.ignored.map((r) => (
          <li key={r.id}>
            <span>
              <strong>{r.sender}</strong>
              {r.reason && <small>{r.reason}</small>}
            </span>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void edit(() => api(`/api/sync/ignore/${r.id}`, "DELETE", {}))
              }
            >
              Ta bort regel
            </button>
          </li>
        ))}
      </ul>
      <details>
        <summary>
          Avvisade förslag · {data?.feedback.length ?? 0} senaste källor
        </summary>
        <p>
          Motiveringar används som relevanta exempel vid nya analyser. Samma
          tråd skapar inte kortet igen. En avvisning ignorerar inte hela
          avsändaren.
        </p>
        <ul className="feedback-list">
          {data?.feedback.map((f) => (
            <li key={f.id}>
              <strong>{f.title}</strong>
              <p>{f.reason}</p>
              <small>
                {f.origin === "user" ? "Din feedback" : "Regeländring"} ·{" "}
                {new Date(f.created_at).toLocaleDateString("sv-SE")}
              </small>
            </li>
          ))}
        </ul>
      </details>
    </details>
  );
}
