import { HttpError } from "./store.js";

/** Shared Graph transport: HTTP GET is the only implemented operation. */
export class GraphReader {
  constructor(
    private token: () => Promise<string>,
    private request: typeof fetch = fetch,
  ) {}
  async get(path: string): Promise<any> {
    const url = new URL(path, "https://graph.microsoft.com/v1.0/");
    if (
      url.origin !== "https://graph.microsoft.com" ||
      !(url.pathname === "/v1.0/me" || url.pathname.startsWith("/v1.0/me/")) ||
      url.username ||
      url.password
    )
      throw new HttpError(502, "Ogiltig Graph-sidadress.");
    let response: Response;
    try {
      response = await this.request(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Prefer:
            'outlook.timezone="W. Europe Standard Time", outlook.body-content-type="text"',
        },
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        "Kunde inte nå Microsoft Graph. Försök igen senare.",
      );
    }
    if (!response.ok)
      throw new HttpError(
        502,
        response.status === 401
          ? "Microsoft-inloggningen behöver förnyas. Anslut Microsoft-kontot igen."
          : response.status === 403
            ? "Microsoft nekade läsåtkomst. Kontrollera delegerade Mail.Read, Calendars.Read och User.Read samt organisationens medgivande."
            : response.status === 429
              ? "Microsoft begränsar antalet förfrågningar. Vänta en stund och försök igen."
              : `Microsoft Graph svarade med HTTP ${response.status}.`,
      );
    if (!response.body)
      throw new HttpError(502, "Microsoft Graph returnerade ett tomt svar.");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4_000_000) {
          await reader.cancel();
          throw new HttpError(
            502,
            "Graph-svaret är för stort. Begränsa sökningen.",
          );
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        "Microsoft Graph returnerade ett ogiltigt svar.",
      );
    } finally {
      reader.releaseLock();
    }
  }
}
