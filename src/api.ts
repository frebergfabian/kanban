import type { ChatEvent, ChatContext } from "../shared/schema.js";

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? "Förfrågan misslyckades. Försök igen.");
  return data as T;
}

export async function chat(
  message: string,
  onEvent: (event: ChatEvent) => void,
  context: ChatContext = {},
) {
  const response = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, ...context }),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error ?? "AI-förfrågan misslyckades.");
  }
  if (!response.body) throw new Error("Webbläsaren kan inte läsa AI-svaret.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  function consume(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line) as ChatEvent;
    if (event.type === "done") done = true;
    onEvent(event);
  }
  try {
    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      let split: number;
      while ((split = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, split));
        buffer = buffer.slice(split + 1);
      }
      if (part.done) break;
    }
    consume(buffer);
    if (!done)
      throw new Error(
        "Anslutningen bröts. Kontrollera tavlan innan du försöker igen.",
      );
  } finally {
    reader.releaseLock();
  }
}

export function requestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
