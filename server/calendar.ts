import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  PublicClientApplication,
  type Configuration,
  type DeviceCodeRequest,
} from "@azure/msal-node";
import { z } from "zod";
import {
  accountInput,
  calendarDraft,
  calendarRange,
  type CalendarAccount,
  type CalendarAccountInput,
  type CalendarResult,
} from "../shared/calendar.js";
import {
  EwsCalendar,
  GraphCalendar,
  type CalendarProvider,
  type EwsTransport,
} from "./calendar-providers.js";
import { Store, HttpError } from "./store.js";

type Row = {
  id: string;
  name: string;
  kind: "online" | "onprem";
  allow_ai: number;
  secret: string;
};
type Secret = CalendarAccountInput & {
  cache?: string;
  connected?: boolean;
  home_account_id?: string;
};
type Options = {
  key?: Buffer;
  keyPath?: string;
  request?: typeof fetch;
  ews?: EwsTransport;
  clientFactory?: (configuration: Configuration) => PublicClientApplication;
};
const scopes = ["https://graph.microsoft.com/Calendars.ReadWrite"];
const safeError = (error: unknown) =>
  error instanceof HttpError
    ? error.message
    : "Kalenderanslutningen misslyckades. Kontrollera inställningarna och anslut kontot igen.";

export class CalendarService {
  private key: Buffer;
  private flows = new Map<
    string,
    {
      request: DeviceCodeRequest;
      login?: CalendarAccount["login"];
      error?: string;
      running: boolean;
    }
  >();
  private clients = new Map<string, PublicClientApplication>();
  private locks = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(
    private store: Store,
    private options: Options = {},
    private audit: (
      event: string,
      detail: Record<string, unknown>,
    ) => void = () => {},
  ) {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS calendar_accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('online','onprem')),
      allow_ai INTEGER NOT NULL DEFAULT 1, secret TEXT NOT NULL, created_at TEXT NOT NULL)`);
    if (options.key) this.key = options.key;
    else {
      const keyPath = resolve(
        options.keyPath ?? resolve(dirname(store.db.name), "calendar.key"),
      );
      mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
      try {
        this.key = readFileSync(keyPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (store.db.prepare("SELECT 1 FROM calendar_accounts LIMIT 1").get())
          throw new Error(
            "calendar.key saknas för befintliga kalenderanslutningar. Återställ nyckeln från backup.",
          );
        this.key = randomBytes(32);
        writeFileSync(keyPath, this.key, { mode: 0o600, flag: "wx" });
      }
      chmodSync(keyPath, 0o600);
    }
    if (this.key.length !== 32)
      throw new Error("Kalenderns krypteringsnyckel måste vara 32 byte.");
  }
  private seal(id: string, value: Secret) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  private secret(row: Row): Secret {
    try {
      const data = Buffer.from(row.secret, "base64"),
        decipher = createDecipheriv(
          "aes-256-gcm",
          this.key,
          data.subarray(0, 12),
        );
      decipher.setAAD(Buffer.from(row.id));
      decipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          decipher.update(data.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      );
    } catch {
      throw new HttpError(
        503,
        "Kalenderkontots krypteringsnyckel stämmer inte. Återställ calendar.key från backup.",
      );
    }
  }
  private row(id: string, ai = false): Row {
    const row = this.store.db
      .prepare("SELECT * FROM calendar_accounts WHERE id=?")
      .get(id) as Row | undefined;
    if (!row || (ai && !row.allow_ai))
      throw new HttpError(404, "Kalenderkontot är inte tillgängligt.");
    return row;
  }
  private save(row: Row, value: Secret) {
    this.store.db
      .prepare("UPDATE calendar_accounts SET secret=? WHERE id=?")
      .run(this.seal(row.id, value), row.id);
  }
  accounts(ai = false): CalendarAccount[] {
    return (
      this.store.db
        .prepare("SELECT * FROM calendar_accounts ORDER BY created_at,id")
        .all() as Row[]
    )
      .filter((row) => !ai || row.allow_ai)
      .map((row) => {
        const flow = this.flows.get(row.id);
        return {
          id: row.id,
          name: row.name,
          kind: row.kind,
          allow_ai: !!row.allow_ai,
          connected: !!this.secret(row).connected,
          ...(!ai && flow?.login && flow.running ? { login: flow.login } : {}),
          ...(!ai && flow?.error ? { error: flow.error } : {}),
        };
      });
  }
  async add(value: unknown) {
    const input = accountInput.parse(value);
    if (this.accounts().length >= 8)
      throw new HttpError(409, "Högst åtta kalenderkonton kan anslutas.");
    const id = randomUUID();
    if (input.kind === "onprem") {
      const now = new Date();
      await new EwsCalendar(id, input, this.options.ews).list(
        now.toISOString(),
        new Date(now.getTime() + 86400000).toISOString(),
      );
    }
    this.store.db
      .prepare(
        "INSERT INTO calendar_accounts(id,name,kind,allow_ai,secret,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        input.name,
        input.kind,
        Number(input.allow_ai),
        this.seal(id, { ...input, connected: input.kind === "onprem" }),
        new Date().toISOString(),
      );
    this.audit("calendar.account_added", { account_id: id, kind: input.kind });
    return this.accounts().find((x) => x.id === id)!;
  }
  permissions(id: string, value: unknown) {
    const { allow_ai } = z
      .object({ allow_ai: z.boolean() })
      .strict()
      .parse(value);
    this.row(id);
    this.store.db
      .prepare("UPDATE calendar_accounts SET allow_ai=? WHERE id=?")
      .run(Number(allow_ai), id);
    this.audit("calendar.ai_access", { account_id: id, allow_ai });
  }
  remove(id: string) {
    this.row(id);
    const flow = this.flows.get(id);
    if (flow) {
      flow.request.cancel = true;
      flow.running = false;
    }
    this.flows.delete(id);
    this.clients.delete(id);
    this.store.db.prepare("DELETE FROM calendar_accounts WHERE id=?").run(id);
    this.audit("calendar.account_removed", { account_id: id });
  }
  private client(id: string) {
    let client = this.clients.get(id);
    if (client) return client;
    const config = this.secret(this.row(id));
    if (config.kind !== "online")
      throw new HttpError(400, "Kontot använder EWS-inloggning.");
    const configuration: Configuration = {
      auth: {
        clientId: config.client_id,
        authority: `https://login.microsoftonline.com/${config.tenant}`,
      },
      system: {
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
      },
      cache: {
        cachePlugin: {
          beforeCacheAccess: async (context) => {
            const secret = this.secret(this.row(id));
            if (secret.cache) context.tokenCache.deserialize(secret.cache);
          },
          afterCacheAccess: async (context) => {
            if (
              !this.closed &&
              context.cacheHasChanged &&
              this.store.db.open &&
              this.store.db
                .prepare("SELECT id FROM calendar_accounts WHERE id=?")
                .get(id)
            ) {
              const row = this.row(id);
              this.save(row, {
                ...this.secret(row),
                cache: context.tokenCache.serialize(),
              });
            }
          },
        },
      },
    };
    client = this.options.clientFactory
      ? this.options.clientFactory(configuration)
      : new PublicClientApplication(configuration);
    this.clients.set(id, client);
    return client;
  }
  login(id: string) {
    const row = this.row(id);
    if (row.kind !== "online")
      throw new HttpError(
        400,
        "EWS-kontot använder användarnamn och lösenord.",
      );
    if (this.flows.get(id)?.running) return;
    const client = this.client(id);
    const flow: {
      request: DeviceCodeRequest;
      login?: CalendarAccount["login"];
      error?: string;
      running: boolean;
    } = {
      running: true,
      request: {
        scopes,
        timeout: 900,
        deviceCodeCallback: (response) => {
          if (!flow.running) return;
          flow.login = {
            code: response.userCode,
            url: response.verificationUri,
            expires_at: new Date(
              Date.now() + response.expiresIn * 1000,
            ).toISOString(),
          };
        },
      },
    };
    this.flows.set(id, flow);
    void client
      .acquireTokenByDeviceCode(flow.request)
      .then((result) => {
        if (!flow.running || this.closed || !result?.account) return;
        const current = this.row(id);
        this.save(current, {
          ...this.secret(current),
          connected: true,
          home_account_id: result.account.homeAccountId,
        });
        this.audit("calendar.login_completed", { account_id: id });
      })
      .catch(() => {
        if (flow.running && !this.closed) {
          flow.error =
            "Microsoft-inloggningen avbröts eller nekades. Kontrollera appregistrering, public client-flöde och medgivande. Försök igen.";
          this.audit("calendar.login_failed", { account_id: id });
        }
      })
      .finally(() => {
        flow.running = false;
        flow.login = undefined;
      });
  }
  private async token(id: string) {
    try {
      const client = this.client(id),
        accounts = await client.getTokenCache().getAllAccounts();
      const account = accounts.find(
        (a) => a.homeAccountId === this.secret(this.row(id)).home_account_id,
      );
      if (!account) throw new Error();
      const result = await client.acquireTokenSilent({ account, scopes });
      return result.accessToken;
    } catch {
      throw new HttpError(
        502,
        "Microsoft-inloggningen behöver förnyas. Öppna Kalenderkonton och logga in igen.",
      );
    }
  }
  private provider(id: string, ai = false): CalendarProvider {
    const row = this.row(id, ai),
      secret = this.secret(row);
    if (!secret.connected)
      throw new HttpError(
        409,
        "Kontot väntar på inloggning. Öppna Kalenderkonton.",
      );
    return secret.kind === "online"
      ? new GraphCalendar(id, () => this.token(id), this.options.request)
      : new EwsCalendar(id, secret, this.options.ews);
  }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  async list(
    input: unknown,
    accountId?: string,
    ai = false,
  ): Promise<CalendarResult> {
    const { start, end } = calendarRange.parse(input);
    const accounts = accountId ? [this.row(accountId, ai)] : this.accounts(ai);
    const result: CalendarResult = {
      events: [],
      errors: [],
      truncated: false,
      fetched_at: new Date().toISOString(),
    };
    await Promise.all(
      accounts.map(async (account) => {
        try {
          const page = await this.serial(account.id, () =>
            this.provider(account.id, ai).list(start, end),
          );
          result.events.push(...page.events);
          result.truncated ||= page.truncated;
        } catch (error) {
          result.errors.push({
            account_id: account.id,
            message: safeError(error),
          });
        }
      }),
    );
    result.events.sort((a, b) => a.start.localeCompare(b.start));
    result.fetched_at = new Date().toISOString();
    this.audit("calendar.read", {
      account_count: accounts.length,
      event_count: result.events.length,
      error_count: result.errors.length,
      errors: result.errors,
      reader: ai ? "ai" : "user",
    });
    return result;
  }
  get(id: string, eventId: string, ai = false) {
    return this.serial(id, () => this.provider(id, ai).get(eventId));
  }
  // This method is only wired to manual HTTP routes. It is never exposed as an AI tool.
  async write(
    id: string,
    action: "create" | "update" | "delete",
    eventId?: string,
    version?: string,
    value?: unknown,
  ) {
    const input = action === "delete" ? undefined : calendarDraft.parse(value);
    await this.serial(id, async () => {
      const provider = this.provider(id);
      if (action === "create") await provider.create(input!);
      else if (action === "update")
        await provider.update(eventId!, version!, input!);
      else await provider.delete(eventId!, version!);
    });
    this.audit(`calendar.${action}`, { account_id: id, actor: "user" });
  }
  close() {
    this.closed = true;
    for (const flow of this.flows.values()) {
      flow.request.cancel = true;
      flow.running = false;
    }
  }
}
