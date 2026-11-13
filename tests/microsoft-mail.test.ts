import { test } from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type {
  Configuration,
  ConfidentialClientApplication,
} from "@azure/msal-node";
import type { AddressInfo } from "node:net";
import { CalendarService } from "../server/calendar.js";
import { Store } from "../server/store.js";
import { Assistant, newSession, tools } from "../server/ai.js";
import { createApp } from "../server/app.js";
import { GraphMail, EwsMail } from "../server/mail-providers.js";
import { microsoftConfigSchema, microsoftScopes } from "../server/microsoft.js";
import { mailSearch } from "../shared/mail.js";
import type { EwsTransport } from "../server/calendar-providers.js";

const config = {
  clientId: "11111111-1111-4111-8111-111111111111",
  clientSecret: "server-secret-never-browser",
  tenant: "common",
  redirectUri: "https://kanban.test/api/microsoft/callback",
};
const ewsAccount = {
  kind: "onprem",
  name: "Jobb",
  endpoint: "https://mail.example/EWS/Exchange.asmx",
  username: "DOMAIN\\tester",
  password: "only-a-test-password",
  auth: "ntlm",
  allow_ai: true,
};
function authMock() {
  let params: any,
    loaded = "",
    silentAccount = "",
    invalidNonce = false;
  const factory = (configuration: Configuration) => {
    const cache = {
      serialize: () => "private-refresh-token-cache",
      deserialize: (value: string) => {
        loaded = value;
      },
    };
    return {
      getAuthCodeUrl: async (request: any) => {
        params = request;
        const url = new URL(
          "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        );
        for (const k of ["state", "nonce", "codeChallenge"])
          url.searchParams.set(k, request[k]);
        return url.toString();
      },
      acquireTokenByCode: async (request: any) => {
        assert.equal(
          createHash("sha256").update(request.codeVerifier).digest("base64url"),
          params.codeChallenge,
        );
        assert.deepEqual(request.scopes, microsoftScopes);
        await configuration.cache?.cachePlugin?.afterCacheAccess({
          tokenCache: cache,
          cacheHasChanged: true,
        } as any);
        return {
          account: { homeAccountId: "chosen-account" },
          accessToken: "private-access-token",
          idTokenClaims: { nonce: invalidNonce ? "wrong" : params.nonce },
        };
      },
      getTokenCache: () => ({
        getAllAccounts: async () => {
          await configuration.cache?.cachePlugin?.beforeCacheAccess({
            tokenCache: cache,
          } as any);
          return [
            { homeAccountId: "old-account" },
            { homeAccountId: "chosen-account" },
          ];
        },
      }),
      acquireTokenSilent: async (request: any) => {
        silentAccount = request.account.homeAccountId;
        assert.deepEqual(request.scopes, microsoftScopes);
        return { accessToken: "private-access-token" };
      },
    } as unknown as ConfidentialClientApplication;
  };
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    assert.equal(
      (init?.headers as any).Authorization,
      "Bearer private-access-token",
    );
    return Response.json(
      new URL(String(url)).pathname === "/v1.0/me"
        ? { displayName: "Fabian Test", mail: "fabian@example.com" }
        : { value: [] },
    );
  }) as typeof fetch;
  return {
    factory,
    request,
    params: () => params,
    loaded: () => loaded,
    silent: () => silentAccount,
    rejectNonce: () => {
      invalidNonce = true;
    },
  };
}
function soap(op: string, body: string) {
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Body><m:${op}Response><m:ResponseMessages><m:${op}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>${body}</m:${op}ResponseMessage></m:ResponseMessages></m:${op}Response></s:Body></s:Envelope>`;
}
const xmlMessage = `<t:Message><t:ItemId Id="mail-id"/><t:Subject>Planera releasen</t:Subject><t:From><t:Mailbox><t:Name>Projektledare</t:Name><t:EmailAddress>sender@example.com</t:EmailAddress></t:Mailbox></t:From><t:ToRecipients><t:Mailbox><t:EmailAddress>fabian@example.com</t:EmailAddress></t:Mailbox></t:ToRecipients><t:DateTimeReceived>2026-11-13T08:00:00Z</t:DateTimeReceived><t:IsRead>false</t:IsRead><t:HasAttachments>true</t:HasAttachments><t:Body BodyType="Text">Leverans på fredag &amp; uppföljning. &lt;img src="https://external.invalid/pixel"&gt;</t:Body></t:Message>`;
const ews: EwsTransport = async (_credentials, xml) => {
  const op = xml.match(/<m:(\w+) /)![1];
  if (op === "FindItem")
    return soap(
      op,
      `<m:RootFolder IncludesLastItemInRange="true"><t:Items>${xml.includes('Id="calendar"') ? "" : xmlMessage}</t:Items></m:RootFolder>`,
    );
  assert.equal(op, "GetItem");
  return soap(op, `<m:Items>${xmlMessage}</m:Items>`);
};

test("Microsoft config is server-owned, HTTPS callback is required outside localhost, and grants are read only", () => {
  assert.ok(microsoftConfigSchema.safeParse(config).success);
  assert.ok(
    !microsoftConfigSchema.safeParse({
      ...config,
      redirectUri: "http://192.168.1.5/api/microsoft/callback",
    }).success,
  );
  assert.ok(
    !microsoftConfigSchema.safeParse({
      ...config,
      redirectUri: "https://kanban.test/api/microsoft/callback?next=evil",
    }).success,
  );
  assert.deepEqual(
    microsoftScopes.map((x) => x.split("/").at(-1)),
    ["Mail.Read", "Calendars.Read", "User.Read"],
  );
});

test("OAuth code + PKCE: browser/state binding, nonce, single use, encrypted MSAL cache, refresh and account deduplication", async () => {
  const store = new Store(":memory:"),
    key = randomBytes(32),
    mock = authMock();
  const service = new CalendarService(store, {
    key,
    microsoft: config,
    clientFactory: mock.factory,
    request: mock.request,
  });
  const browser = "bound-browser";
  try {
    assert.ok(
      !JSON.stringify(service.microsoftStatus()).includes(config.clientSecret),
    );
    let url = new URL(await service.beginMicrosoft(browser));
    await assert.rejects(
      service.finishMicrosoft(
        url.searchParams.get("state")!,
        "another-browser",
        "code",
      ),
      /webbläsarsession/,
    );
    assert.equal(service.accounts().length, 0);
    url = new URL(await service.beginMicrosoft(browser));
    const state = url.searchParams.get("state")!,
      id = await service.finishMicrosoft(state, browser, "authorization-code");
    await assert.rejects(
      service.finishMicrosoft(state, browser, "authorization-code"),
      /webbläsarsession/,
    );
    assert.equal(service.accounts()[0].name, "Fabian Test");
    assert.equal(service.accounts()[0].connected, true);
    const raw = JSON.stringify(
      store.db.prepare("SELECT * FROM calendar_accounts").all(),
    );
    assert.ok(!raw.includes("private-refresh-token-cache"));
    assert.ok(!raw.includes("private-access-token"));
    assert.ok(!raw.includes(config.clientSecret));
    const restarted = new CalendarService(store, {
      key,
      microsoft: config,
      clientFactory: mock.factory,
      request: mock.request,
    });
    await restarted.searchMail({ account_id: id });
    assert.equal(mock.loaded(), "private-refresh-token-cache");
    assert.equal(mock.silent(), "chosen-account");
    service.permissions(id, { allow_ai: false });
    url = new URL(await service.beginMicrosoft(browser));
    await service.finishMicrosoft(
      url.searchParams.get("state")!,
      browser,
      "new-code",
    );
    assert.equal(service.accounts().length, 1);
    assert.equal(service.accounts()[0].id, id);
    assert.equal(service.accounts()[0].allow_ai, false);
    const expired = new URL(await service.beginMicrosoft(browser));
    const clock = Date.now;
    try {
      Date.now = () => clock() + 601000;
      await assert.rejects(
        service.finishMicrosoft(
          expired.searchParams.get("state")!,
          browser,
          "code",
        ),
        /webbläsarsession/,
      );
    } finally {
      Date.now = clock;
    }
    await assert.rejects(
      service.searchMail({ account_id: id }, true),
      /inte tillgängligt|tillåter/,
    );
    await assert.rejects(
      service.write(id, "create", undefined, undefined, {}),
      /skrivskyddad/,
    );
    restarted.close();
    mock.rejectNonce();
    url = new URL(await service.beginMicrosoft(browser));
    await assert.rejects(
      service.finishMicrosoft(
        url.searchParams.get("state")!,
        browser,
        "invalid-code",
      ),
      /misslyckades/,
    );
    assert.equal(service.accounts().length, 1);
  } finally {
    service.close();
    store.close();
  }
});

test("legacy Microsoft ReadWrite caches are retired, with on-prem credentials preserved unchanged", async () => {
  const store = new Store(":memory:"),
    key = randomBytes(32),
    first = new CalendarService(store, { key, ews });
  try {
    const onprem = await first.add(ewsAccount);
    const before = (
      store.db
        .prepare("SELECT secret FROM calendar_accounts WHERE id=?")
        .get(onprem.id) as any
    ).secret;
    const id = randomUUID();
    store.db.prepare("INSERT INTO calendar_accounts VALUES(?,?,?,?,?,?)").run(
      id,
      "Legacy",
      "online",
      1,
      (first as any).seal(id, {
        kind: "online",
        name: "Legacy",
        allow_ai: true,
        client_id: config.clientId,
        connected: true,
        cache: "old-ReadWrite-refresh-cache",
      }),
      new Date().toISOString(),
    );
    const second = new CalendarService(store, { key, ews, microsoft: config });
    assert.equal(second.accounts().find((a) => a.id === id)?.connected, false);
    assert.equal(
      (
        store.db
          .prepare("SELECT secret FROM calendar_accounts WHERE id=?")
          .get(onprem.id) as any
      ).secret,
      before,
    );
    assert.ok(!(second as any).secret((second as any).row(id)).cache);
    assert.equal(
      (await second.searchMail({ account_id: onprem.id })).messages.length,
      1,
    );
    second.close();
  } finally {
    first.close();
    store.close();
  }
});

test("Graph mail reads preserve pagination and text, constrain URL origins and never modify read state or fetch attachments", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const message = {
    id: "m/id",
    subject: "Release",
    from: { emailAddress: { name: "Sender", address: "sender@example.com" } },
    receivedDateTime: "2026-11-13T08:00:00Z",
    isRead: false,
    hasAttachments: true,
    bodyPreview: "preview",
    body: { content: "<script>unsafe()</script>" },
  };
  const reader = new GraphMail("account", async () => "secret", (async (
    url,
    init,
  ) => {
    const u = new URL(String(url));
    calls.push({ url: u, init: init! });
    return Response.json(
      u.pathname.includes("/messages/")
        ? message
        : {
            value: [message],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=47",
          },
    );
  }) as typeof fetch);
  const page = await reader.search(
    mailSearch.parse({
      account_id: randomUUID(),
      query: 'subject:"Release"',
      limit: 5,
    }),
  );
  assert.equal(page.next_offset, 47);
  assert.equal(page.messages[0].is_read, false);
  assert.equal(page.messages[0].has_attachments, true);
  assert.equal(
    calls[0].url.searchParams.get("$search"),
    JSON.stringify('subject:"Release"'),
  );
  const detail = await reader.get("m/id");
  assert.match(detail.body, /<script>/);
  assert.equal(detail.is_read, false);
  assert.ok(
    calls.every(
      (c) =>
        c.init.method === "GET" &&
        !c.init.body &&
        !c.url.pathname.includes("attachments"),
    ),
  );
  const bad = new GraphMail("a", async () => "token", (async () =>
    Response.json({
      value: [],
      "@odata.nextLink": "https://evil.example/?$skip=20",
    })) as typeof fetch);
  await assert.rejects(
    bad.search(mailSearch.parse({ account_id: randomUUID() })),
    /sidadress/,
  );
});

test("EWS mail uses FindItem/GetItem only, supports escaped search and folder pagination, and gets text without marking read", async () => {
  const calls: string[] = [];
  const provider = new EwsMail(
    "onprem",
    {
      endpoint: ewsAccount.endpoint,
      username: ewsAccount.username,
      password: ewsAccount.password,
      auth: "ntlm",
    },
    async (credentials, xml) => {
      calls.push(xml);
      return ews(credentials, xml);
    },
  );
  const page = await provider.search(
    mailSearch.parse({
      account_id: randomUUID(),
      query: 'Release <plan> & subject:"fredag"',
      folder: "sent",
    }),
  );
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].is_read, false);
  assert.match(calls[0], /Id="sentitems"/);
  assert.match(calls[0], /&lt;plan&gt; &amp;/);
  assert.ok(!calls[0].includes('Id="calendar"'));
  const detail = await provider.get("mail-id");
  assert.match(detail.body, /& uppföljning/);
  assert.equal(detail.from.address, "sender@example.com");
  assert.ok(calls.every((xml) => /<m:(FindItem|GetItem) /.test(xml)));
  assert.match(calls[1], /<t:BodyType>Text/);
  const invites = new EwsMail(
    "onprem",
    {
      endpoint: ewsAccount.endpoint,
      username: ewsAccount.username,
      password: ewsAccount.password,
      auth: "ntlm",
    },
    async (credentials, xml) =>
      (await ews(credentials, xml)).replaceAll(
        "t:Message>",
        "t:MeetingRequest>",
      ),
  );
  assert.equal(
    (await invites.search(mailSearch.parse({ account_id: randomUUID() })))
      .messages.length,
    1,
  );
  assert.equal((await invites.get("mail-id")).subject, "Planera releasen");
});

test("HTTP OAuth cookies/callback privacy, no mail write routes, separate AI reads and durable selected source context", async () => {
  const store = new Store(":memory:"),
    mock = authMock(),
    seen: any[] = [];
  let index = 0,
    readAccountId = "";
  const assistant = new Assistant(
    store,
    { url: "http://model.test", model: "test", timeout: 1000 },
    (async (url, init) => {
      if (String(url).endsWith("/api/show"))
        return Response.json({ capabilities: ["tools"] });
      const body = JSON.parse(String(init?.body));
      seen.push(body);
      return Response.json({
        message:
          index++ === 0
            ? {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    function: {
                      name: "get_mail",
                      arguments: {
                        account_id: readAccountId,
                        message_id: "mail-id",
                      },
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: "Läste mejlet och relaterade det till kortet.",
              },
      });
    }) as typeof fetch,
  );

  const service = (assistant.calendar = new CalendarService(
    store,
    {
      key: randomBytes(32),
      microsoft: config,
      clientFactory: mock.factory,
      request: mock.request,
      ews,
    },
    (event, detail) => assistant.knowledge.log(event, detail),
  ));
  const app = createApp(store, assistant),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function oauth(
    path: string,
    cookie?: string,
  ): Promise<{ status: number; headers: any; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        base + path,
        {
          headers: {
            Host: "kanban.test",
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (data) => (body += data));
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers, body }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  try {
    const status = await (await fetch(base + "/api/microsoft/status")).json();
    assert.ok(!JSON.stringify(status).includes(config.clientSecret));
    const start = await oauth("/api/microsoft/connect");
    assert.equal(start.status, 303);
    const cookieHeader = start.headers["set-cookie"]?.[0];
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Lax/);
    assert.match(cookieHeader, /Secure/);
    const cookie = cookieHeader.split(";")[0],
      state = new URL(start.headers.location).searchParams.get("state");
    const callback = await oauth(
      `/api/microsoft/callback?state=${state}&code=private-authorization-code`,
      cookie,
    );
    assert.equal(callback.status, 303);
    assert.equal(
      callback.headers.location,
      "https://kanban.test/#mail?microsoft=connected",
    );
    assert.ok(!callback.body.includes("private-authorization-code"));
    const replay = await oauth(
      `/api/microsoft/callback?state=${state}&code=private-authorization-code`,
      cookie,
    );
    assert.equal(
      replay.headers.location,
      "https://kanban.test/#mail?microsoft=failed",
    );
    const a = await service.add(ewsAccount),
      task = store.create({ title: "Följ upp releasen" });
    readAccountId = a.id;
    const result = await assistant.executeTool(
      "search_mail",
      { account_id: a.id },
      newSession(),
    );
    assert.equal((result.result.messages as any[]).length, 1);
    const mail = await assistant.executeTool(
      "get_mail",
      { account_id: a.id, message_id: "mail-id" },
      newSession(),
    );
    assert.match((mail.result.message as any).body, /uppföljning/);
    for (const name of [
      "send_mail",
      "delete_mail",
      "update_mail",
      "mark_mail_read",
      "create_calendar_event",
    ])
      await assert.rejects(
        assistant.executeTool(name, {}, newSession()),
        /inte tillåtet/,
      );
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await fetch(
        base + `/api/mail/accounts/${a.id}/messages/mail-id`,
        { method, headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      assert.equal(response.status, 404);
    }
    const input = {
      request_id: randomUUID(),
      message: "Sammanfatta valt mejl och jämför med kortet.",
      board_id: task.board_id,
      task_id: task.id,
      external_context: { kind: "mail", account_id: a.id, item_id: "mail-id" },
    };
    const job = (
      await (
        await fetch(base + "/api/ai/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
      ).json()
    ).job;
    for (let i = 0; i < 100; i++) {
      if (
        !["queued", "running"].includes(assistant.knowledge.job(job.id).status)
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(seen.length);
    assert.match(seen[0].messages[0].content, /selected_external_item/);
    assert.match(seen[0].messages[0].content, /mail-id/);
    assert.equal(
      assistant.knowledge.job(job.id).external_context?.item_id,
      "mail-id",
    );
    assert.equal(
      JSON.parse(
        (
          store.db
            .prepare("SELECT context FROM ai_external_context WHERE job_id=?")
            .get(job.id) as any
        ).context,
      ).item_id,
      "mail-id",
    );
    service.permissions(a.id, { allow_ai: false });
    const denied = await fetch(base + "/api/ai/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, request_id: randomUUID() }),
    });
    assert.equal(denied.status, 403);
    assert.ok(
      !JSON.stringify(assistant.knowledge.logs({ limit: 100 })).includes(
        ewsAccount.password,
      ),
    );
  } finally {
    service.close();
    await app.locals.jobQueue.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
