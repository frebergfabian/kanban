import { DateTime } from "luxon";
import type { AnalysisRequest } from "../shared/sync.js";

// Narrow human commands avoid an extra slow LLM round trip. More complex
// account selections and queries use the documented AI tools.
export function analysisCommand(
  message: string,
  now = Date.now(),
): AnalysisRequest | undefined {
  const text = message
    .toLocaleLowerCase("sv")
    .trim()
    .replace(/[.!?]+$/, "");
  const count = text.match(
    /^(?:kan du )?analysera (?:mina |de )?(\d+) senaste (mail|mejl|e-post|kalenderobjekt|kalenderhändelser)$/,
  );
  if (count && Number(count[1]) >= 1 && Number(count[1]) <= 10000)
    return {
      kind: count[2].startsWith("kalender") ? "calendar" : "mail",
      limit: Number(count[1]),
    };
  const range = text.match(
    /^(?:kan du )?analysera (?:mina )?(mail|mejl|e-post|kalenderobjekt|kalenderhändelser) (?:från )?(den här veckan|denna vecka|förra veckan|idag|i dag|igår)$/,
  );
  if (!range) return undefined;
  const date = DateTime.fromMillis(now, { zone: "Europe/Stockholm" });
  const period = range[2];
  const from =
    period === "förra veckan"
      ? date.minus({ weeks: 1 }).startOf("week")
      : period === "igår"
        ? date.minus({ days: 1 }).startOf("day")
        : /vecka/.test(period)
          ? date.startOf("week")
          : date.startOf("day");
  const to =
    period === "förra veckan"
      ? from.plus({ weeks: 1 })
      : period === "igår"
        ? from.plus({ days: 1 })
        : date;
  return {
    kind: range[1].startsWith("kalender") ? "calendar" : "mail",
    from: from.toISO()!,
    to: to.toISO()!,
  };
}
