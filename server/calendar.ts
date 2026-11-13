import {
  createHash,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ConfidentialClientApplication,
  type Configuration,
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
import { GraphReader } from "./graph.js";
import { EwsMail, GraphMail, type MailReader } from "./mail-providers.js";
import { mailSearch, type MailPage } from "../shared/mail.js";
import {
  microsoftFromEnv,
  microsoftScopes,
  type MicrosoftConfig,
} from "./microsoft.js";

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
  app_client_id?: string;
  policy?: string;
};
type Options = {
  key?: Buffer;
  keyPath?: string;
  request?: typeof fetch;
  ews?: EwsTransport;
  microsoft?: MicrosoftConfig;
  clientFactory?: (
    configuration: Configuration,
  ) => ConfidentialClientApplication;
};
const scopes = microsoftScopes;
const policy = "microsoft-read-v1";
const safeError = (error: unknown) =>
  error instanceof HttpError
    ? error.message
    : "Kalenderanslutningen misslyckades. Kontrollera inställningarna och anslut kontot igen.";

export class CalendarService {
  private key: Buffer;
  private flows = new Map<
    string,
    {
      id: string;
      verifier: string;
      nonce: string;
      browser: Buffer;
      expires: number;
    }
  >();
  private clients = new Map<string, ConfidentialClientApplication>();
  private microsoft: MicrosoftConfig | undefined;
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
    this.microsoft = options.microsoft ?? microsoftFromEnv();
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
    // Retire per-user app settings and every old ReadWrite cache before exposing Graph.
    for (const row of this.store.db
      .prepare("SELECT * FROM calendar_accounts WHERE kind='online'")
      .all() as Row[]) {
      const previous = this.secret(row);
      if (previous.policy !== policy)
        this.save(row, {
          kind: "online",
          name: row.name,
          allow_ai: !!row.allow_ai,
          home_account_id: previous.home_account_id,
          connected: false,
          policy,
        });
    }
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
        return {
          id: row.id,
          name: row.name,
          kind: row.kind,
          allow_ai: !!row.allow_ai,
          connected:
            !!this.secret(row).connected &&
            (row.kind === "onprem" ||
              (!!this.microsoft &&
                this.secret(row).app_client_id === this.microsoft.clientId)),
        };
      });
  }
  async add(value: unknown) {
    const input = accountInput.parse(value);
    if (this.accounts().length >= 8)
      throw new HttpError(409, "Högst åtta kalenderkonton kan anslutas.");
    if (input.kind === "online")
      throw new HttpError(400, "Använd Anslut Microsoft-konto.");
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
    this.clients.delete(id);
    this.store.db.prepare("DELETE FROM calendar_accounts WHERE id=?").run(id);
    this.audit("calendar.account_removed", { account_id: id });
  }
  private client(id: string) {
    let client = this.clients.get(id);
    if (client) return client;
    const config = this.secret(this.row(id));
    if (config.kind !== "online" || !this.microsoft)
      throw new HttpError(400, "Kontot använder EWS-inloggning.");
    const configuration: Configuration = {
      auth: {
        clientId: this.microsoft.clientId,
        clientSecret: this.microsoft.clientSecret,
        authority: `https://login.microsoftonline.com/${this.microsoft.tenant}`,
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
      : new ConfidentialClientApplication(configuration);
    this.clients.set(id, client);
    return client;
  }
  microsoftStatus() {
    return {
      configured: !!this.microsoft,
      connect_url: this.microsoft
        ? new URL(
            "/api/microsoft/connect",
            this.microsoft.redirectUri,
          ).toString()
        : null,
      message: this.microsoft
        ? "Läsåtkomst till e-post, kalender och kontoprofil."
        : "Microsoft-inloggningen väntar på serveradministratörens appkonfiguration.",
    };
  }
  microsoftOrigin() {
    return this.microsoft
      ? new URL(this.microsoft.redirectUri).origin
      : undefined;
  }
  async beginMicrosoft(browser: string) {
    if (!this.microsoft)
      throw new HttpError(503, this.microsoftStatus().message);
    const now = Date.now();
    for (const [state, flow] of this.flows)
      if (flow.expires <= now) this.flows.delete(state);
    if (this.flows.size >= 32 || this.accounts().length >= 8)
      throw new HttpError(
        429,
        "För många anslutningar. Ta bort en koppling eller försök igen senare.",
      );
    const state = randomBytes(32).toString("base64url"),
      id = randomUUID(),
      verifier = randomBytes(48).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    this.flows.set(state, {
      id,
      verifier,
      nonce,
      browser: createHash("sha256").update(browser).digest(),
      expires: now + 600000,
    });
    const configuration: Configuration = {
      auth: {
        clientId: this.microsoft.clientId,
        clientSecret: this.microsoft.clientSecret,
        authority: `https://login.microsoftonline.com/${this.microsoft.tenant}`,
      },
      system: {
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
      },
    };
    const client = this.options.clientFactory
      ? this.options.clientFactory(configuration)
      : new ConfidentialClientApplication(configuration);
    try {
      return await client.getAuthCodeUrl({
        scopes,
        state,
        nonce,
        redirectUri: this.microsoft.redirectUri,
        codeChallenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        codeChallengeMethod: "S256",
        prompt: "select_account",
      });
    } catch {
      this.flows.delete(state);
      throw new HttpError(
        502,
        "Kunde inte starta Microsoft-inloggningen. Kontrollera serverns appkonfiguration.",
      );
    }
  }
  async finishMicrosoft(state: string, browser: string, code?: string) {
    const flow = this.flows.get(state);
    this.flows.delete(state); // A callback is single use, including denied attempts.
    if (
      !flow ||
      flow.expires <= Date.now() ||
      !timingSafeEqual(
        flow.browser,
        createHash("sha256").update(browser).digest(),
      ) ||
      !this.microsoft
    )
      throw new HttpError(
        400,
        "Microsoft-inloggningen har gått ut eller saknar rätt webbläsarsession. Försök ansluta igen.",
      );
    if (!code)
      throw new HttpError(400, "Microsoft-inloggningen avbröts eller nekades.");
    if (this.accounts().length >= 8)
      throw new HttpError(409, "Högst åtta konton kan anslutas.");
    const initial: Secret = {
      kind: "online",
      name: "Microsoft 365",
      allow_ai: true,
      connected: false,
      policy,
      app_client_id: this.microsoft.clientId,
    };
    this.store.db
      .prepare(
        "INSERT INTO calendar_accounts(id,name,kind,allow_ai,secret,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        flow.id,
        initial.name,
        "online",
        1,
        this.seal(flow.id, initial),
        new Date().toISOString(),
      );
    try {
      const result = await this.client(flow.id).acquireTokenByCode({
        code,
        scopes,
        redirectUri: this.microsoft.redirectUri,
        codeVerifier: flow.verifier,
      });
      if (
        !result?.account ||
        (result.idTokenClaims as Record<string, unknown> | undefined)?.nonce !==
          flow.nonce
      )
        throw new Error("Invalid Microsoft identity");
      // Profile is obtained with the same delegated User.Read grant; no mail is read during sign-in.
      const profile = await new GraphReader(
        async () => result.accessToken,
        this.options.request,
      ).get("me?$select=displayName,mail,userPrincipalName");
      const name = String(
        profile.displayName ||
          profile.mail ||
          profile.userPrincipalName ||
          "Microsoft 365",
      ).slice(0, 80);
      const row = this.row(flow.id),
        secret = this.secret(row);
      const existing = (
        this.store.db
          .prepare(
            "SELECT * FROM calendar_accounts WHERE kind='online' AND id!=?",
          )
          .all(flow.id) as Row[]
      ).find(
        (r) => this.secret(r).home_account_id === result.account!.homeAccountId,
      );
      const destination = existing ?? row;
      this.save(destination, {
        ...secret,
        name,
        connected: true,
        home_account_id: result.account.homeAccountId,
      });
      this.store.db
        .prepare("UPDATE calendar_accounts SET name=? WHERE id=?")
        .run(name, destination.id);
      if (existing) {
        this.clients.delete(destination.id);
        this.store.db
          .prepare("DELETE FROM calendar_accounts WHERE id=?")
          .run(flow.id);
      }
      this.audit("microsoft.connected", {
        account_id: destination.id,
        permissions: ["Mail.Read", "Calendars.Read", "User.Read"],
      });
      return destination.id;
    } catch {
      this.store.db
        .prepare("DELETE FROM calendar_accounts WHERE id=?")
        .run(flow.id);
      this.audit("microsoft.login_failed", {});
      throw new HttpError(
        502,
        "Microsoft-inloggningen misslyckades. Kontrollera serverns appkonfiguration och medgivandet och försök igen.",
      );
    } finally {
      this.clients.delete(flow.id);
    }
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
        "Microsoft-inloggningen behöver förnyas. Använd Anslut Microsoft-konto igen.",
      );
    }
  }
  private provider(id: string, ai = false): CalendarProvider {
    const row = this.row(id, ai),
      secret = this.secret(row);
    if (
      !secret.connected ||
      (row.kind === "online" &&
        (!this.microsoft || secret.app_client_id !== this.microsoft.clientId))
    )
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
    if (this.row(id).kind === "online")
      throw new HttpError(403, "Microsoft 365-kalendern är skrivskyddad.");
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
  private mailProvider(id: string, ai: boolean): MailReader {
    const row = this.row(id, ai),
      secret = this.secret(row);
    if (!this.accounts(ai).some((a) => a.id === id && a.connected))
      throw new HttpError(409, "Kontot behöver anslutas igen.");
    return secret.kind === "online"
      ? new GraphMail(id, () => this.token(id), this.options.request)
      : new EwsMail(id, secret, this.options.ews);
  }
  async searchMail(value: unknown, ai = false): Promise<MailPage> {
    const input = mailSearch.parse(value);
    const result = await this.serial(input.account_id, () =>
      this.mailProvider(input.account_id, ai).search(input),
    );
    this.audit("mail.search", {
      account_id: input.account_id,
      reader: ai ? "ai" : "user",
      result_count: result.messages.length,
      folder: input.folder,
    });
    return result;
  }
  async getMail(id: string, mailId: string, ai = false) {
    const result = await this.serial(id, () =>
      this.mailProvider(id, ai).get(mailId),
    );
    this.audit("mail.read", { account_id: id, reader: ai ? "ai" : "user" });
    return result;
  }
  close() {
    this.closed = true;
    this.flows.clear();
  }
}
