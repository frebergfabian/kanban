import { useState } from "react";
import type { AiJob } from "../shared/schema.js";
import { api } from "./api.js";
const labels = {
  queued: "I kö",
  running: "Kör",
  needs_input: "Behöver svar",
  completed: "Klart",
  failed: "Fel",
  cancelled: "Avbrutet",
  interrupted: "Avbrutet vid omstart",
};
export function JobRail({
  jobs,
  onOpen,
  onNew,
  onRefresh,
}: {
  jobs: AiJob[];
  onOpen: (job: AiJob) => void;
  onNew: () => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false),
    [error, setError] = useState("");
  const active = jobs.filter((j) =>
      ["queued", "running", "needs_input"].includes(j.status),
    ),
    head = active[0] ?? jobs[0];
  if (!head) return null;
  async function action(job: AiJob, path: string, body = {}) {
    setError("");
    try {
      await api(`/api/ai/jobs/${job.id}/${path}`, "POST", body);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="job-rail">
      <div className="job-pill">
        <button
          className="job-primary"
          onClick={() => onOpen(head)}
          title={head.message}
        >
          <span
            className={head.status === "running" ? "spinner" : "job-symbol"}
          >
            {head.status === "running"
              ? ""
              : head.status === "needs_input"
                ? "?"
                : head.status === "completed"
                  ? "✓"
                  : "✦"}
          </span>
          <span>
            <strong>{head.message}</strong>
            <small>{head.progress || labels[head.status]}</small>
          </span>
        </button>
        <button
          className="job-count"
          aria-label="Visa AI-kön"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {active.length || jobs.length} ▾
        </button>
        <button
          className="icon-button small"
          aria-label="Lägg till AI-uppgift"
          onClick={onNew}
        >
          +
        </button>
      </div>
      {active.length > 1 && (
        <div className="job-running-order">
          {active.slice(1, 4).map((j, i) => (
            <button key={j.id} onClick={() => onOpen(j)} title={j.message}>
              {i + 2}. {j.message}
            </button>
          ))}
          {active.length > 4 && <span>+{active.length - 4}</span>}
        </div>
      )}
      {expanded && (
        <section className="job-dropdown" aria-label="AI-kö">
          <header>
            <strong>AI-jobb · ett åt gången</strong>
            <button
              className="icon-button small"
              aria-label="Stäng AI-kön"
              onClick={() => setExpanded(false)}
            >
              ×
            </button>
          </header>
          <p className="field-help mb-3">
            Jobben fortsätter när chatten är stängd. Avbrutet arbete rullas inte
            tillbaka.
          </p>
          {jobs.map((j) => (
            <article className="job-row" key={j.id}>
              <button
                onClick={() => {
                  onOpen(j);
                  setExpanded(false);
                }}
              >
                <strong>{j.message}</strong>
                <small>
                  {labels[j.status]} · {j.progress}
                </small>
              </button>
              <div className="flex gap-2">
                {j.status === "queued" && (
                  <>
                    <button
                      className="icon-button small"
                      aria-label={`Flytta upp ${j.message}`}
                      onClick={() =>
                        void action(j, "move", { direction: "up" })
                      }
                    >
                      ↑
                    </button>
                    <button
                      className="icon-button small"
                      aria-label={`Flytta ned ${j.message}`}
                      onClick={() =>
                        void action(j, "move", { direction: "down" })
                      }
                    >
                      ↓
                    </button>
                  </>
                )}
                {["queued", "running"].includes(j.status) ? (
                  <button
                    className="text-button"
                    onClick={() => void action(j, "cancel")}
                  >
                    Avbryt
                  </button>
                ) : (
                  j.status !== "needs_input" && (
                    <button
                      className="text-button"
                      onClick={() => void action(j, "dismiss")}
                    >
                      Dölj
                    </button>
                  )
                )}
              </div>
            </article>
          ))}
          {error && (
            <p className="error mt-3" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
