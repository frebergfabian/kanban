import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import type { Workflow } from "../server/workflow.js";
import { api } from "./api.js";
type Daily = ReturnType<Workflow["daily"]>;
const clock = (value: string) =>
  DateTime.fromISO(value).setZone("Europe/Stockholm").toFormat("HH:mm");
export function DailyAgenda({
  boardId,
  onOpenTask,
}: {
  boardId: string;
  onOpenTask: (id: string) => void;
}) {
  const [data, setData] = useState<Daily>(),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = () =>
      void api<Daily>("/api/sync/daily")
        .then((d) => {
          if (live) {
            setData(d);
            setError("");
          }
        })
        .catch(() => {
          if (live) setError("Dagens agenda kunde inte hämtas.");
        });
    load();
    const timer = setInterval(load, 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (data && data.main_board_id !== boardId) return null;
  return (
    <section
      className="daily-agenda"
      aria-label="Dagens agenda och morgonsammanfattning"
    >
      <header className="daily-heading">
        <div>
          <span className="eyebrow">Din dag</span>
          <h2>Dagens agenda</h2>
          <p>
            {data
              ? DateTime.fromISO(data.day)
                  .setLocale("sv")
                  .toFormat("cccc d LLLL")
              : "Läser agenda…"}{" "}
            · Stockholm
          </p>
        </div>
        <a href="#sync">Synk och underlag</a>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="daily-metrics">
            <span className="metric agenda-color">
              <b>{data.agenda.length}</b> kalenderhändelser
            </span>
            <span className="metric done-color">
              <b>{data.yesterday.completed.length}</b> klara igår
            </span>
            <span className="metric overdue-color">
              <b>{data.due.length}</b> förfallna / förfaller idag
            </span>
            <span className="metric waiting-color">
              <b>{data.waiting.length}</b> väntar
            </span>
          </div>
          <div className="agenda-list">
            {data.agenda.length === 0 ? (
              <p className="muted">Inga synkade kalenderhändelser idag.</p>
            ) : (
              data.agenda.map((e) => (
                <a
                  key={e.source_id}
                  className={`agenda-event ${e.preparation ? "needs-prep" : ""}`}
                  href={`#sync?source=${e.source_id}`}
                >
                  <time>
                    {DateTime.fromISO(e.starts_at).setZone("Europe/Stockholm")
                      .hour === 0 &&
                    e.ends_at &&
                    DateTime.fromISO(e.ends_at).setZone("Europe/Stockholm")
                      .hour === 0 &&
                    Date.parse(e.ends_at) - Date.parse(e.starts_at) >=
                      23 * 3600000
                      ? "Heldag"
                      : `${clock(e.starts_at)}${e.ends_at ? `–${clock(e.ends_at)}` : ""}`}
                  </time>
                  <span>{e.title}</span>
                  <small>
                    {e.preparation ? "Förarbete i underlaget" : "Kalender"}
                  </small>
                </a>
              ))
            )}
          </div>
          <details className="daily-brief" open>
            <summary>
              Morgonsammanfattning ·{" "}
              {data.created_at
                ? `skapad ${clock(data.created_at)}`
                : "skapas klockan 06:00"}
            </summary>
            {data.brief ? (
              <>
                <p>
                  {data.brief.agenda.length} kalenderhändelser i morgonens
                  agenda. {data.brief.yesterday.completed.length} kort
                  markerades klara igår och {data.brief.yesterday.updated_cards}{" "}
                  kort fick inlägg.
                </p>
                <div className="daily-sections">
                  <div>
                    <h3>Gårdagens resultat</h3>
                    {!data.brief.yesterday.completed.length ? (
                      <p className="muted">
                        Inga registrerade flyttar till Klart.
                      </p>
                    ) : (
                      data.brief.yesterday.completed.map((t) => (
                        <button
                          className="daily-task done-color"
                          key={t.task_id ?? t.title}
                          disabled={!t.task_id}
                          onClick={() => t.task_id && onOpenTask(t.task_id)}
                        >
                          {t.title}
                        </button>
                      ))
                    )}
                  </div>
                  <div>
                    <h3>Att hålla koll på</h3>
                    {data.brief.urgent.map((t) => (
                      <button
                        className="daily-task overdue-color"
                        key={t.id}
                        onClick={() => onOpenTask(t.id)}
                      >
                        {t.urgency}% · {t.title}
                      </button>
                    ))}
                    {data.brief.due.map((t) => (
                      <button
                        className="daily-task"
                        key={t.id}
                        onClick={() => onOpenTask(t.id)}
                      >
                        {t.due_date} · {t.title}
                      </button>
                    ))}
                    {!data.brief.urgent.length && !data.brief.due.length && (
                      <p className="muted">
                        Inga högt prioriterade eller förfallande kort i
                        morgonens underlag.
                      </p>
                    )}
                  </div>
                  <div>
                    <h3>Väntande arbete</h3>
                    {data.brief.waiting.map((t) => (
                      <button
                        className="daily-task waiting-color"
                        key={t.id}
                        onClick={() => onOpenTask(t.id)}
                      >
                        {t.title}
                        {t.reason ? ` · ${t.reason}` : ""}
                        {t.until_date ? ` · Följ upp ${t.until_date}` : ""}
                      </button>
                    ))}
                    {!data.brief.waiting.length && (
                      <p className="muted">Inga kort i Väntar.</p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="muted">
                En sammanfattning sparas varje morgon kl. 06:00. Om servern
                varit avstängd skapas dagens sammanfattning när den startar
                efter 06.
              </p>
            )}
          </details>
          <p className="daily-notice">{data.notice}</p>
        </>
      )}
    </section>
  );
}
