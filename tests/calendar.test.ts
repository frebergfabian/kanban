import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer as httpsServer } from "node:https";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../server/store.js";
import { Assistant, newSession, tools } from "../server/ai.js";
import { createApp } from "../server/app.js";
import { CalendarService } from "../server/calendar.js";
import {
  EwsCalendar,
  GraphCalendar,
  curlEws,
  type EwsTransport,
} from "../server/calendar-providers.js";
import { calendarDraft, calendarRange } from "../shared/calendar.js";

const input = {
  title: "Boka <tid> & planera",
  description: "Privat beskrivning",
  location: "Kontoret",
  all_day: false as const,
  start: "2026-11-13T09:00:00+01:00",
  end: "2026-11-13T10:00:00+01:00",
};
const range = {
  start: "2026-11-01T00:00:00+01:00",
  end: "2026-12-01T00:00:00+01:00",
};
const account = {
  kind: "onprem" as const,
  name: "Jobb",
  endpoint: "https://exchange.example/EWS/Exchange.asmx",
  username: "DOM\\fabian",
  password: 'private-password-"\\&',
  auth: "ntlm" as const,
  allow_ai: true,
};
function envelope(op: string, body: string, code = "NoError") {
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Body><m:${op}Response><m:ResponseMessages><m:${op}ResponseMessage ResponseClass="${code === "NoError" ? "Success" : "Error"}"><m:ResponseCode>${code}</m:ResponseCode>${body}</m:${op}ResponseMessage></m:ResponseMessages></m:${op}Response></s:Body></s:Envelope>`;
}
function item(version = "v1", meeting = false, type = "Single") {
  return `<t:CalendarItem><t:ItemId Id="ews-id" ChangeKey="${version}"/><t:Subject>Jobbmöte</t:Subject><t:Body BodyType="Text">Privat beskrivning &amp; innehåll</t:Body><t:Start>2026-11-13T09:00:00+01:00</t:Start><t:End>2026-11-13T10:00:00+01:00</t:End><t:IsAllDayEvent>false</t:IsAllDayEvent><t:Location>Kontoret</t:Location><t:CalendarItemType>${type}</t:CalendarItemType><t:IsMeeting>${meeting}</t:IsMeeting></t:CalendarItem>`;
}
function ewsFake() {
  const calls: { operation: string; xml: string }[] = [];
  let version = "v1",
    meeting = false;
  const request: EwsTransport = async (_credentials, xml) => {
    const op = xml.match(/<m:(\w+) /)![1];
    calls.push({ operation: op, xml });
    if (op === "FindItem")
      return envelope(
        op,
        `<m:RootFolder IncludesLastItemInRange="true"><t:Items>${item(version, meeting)}</t:Items></m:RootFolder>`,
      );
    if (op === "GetItem")
      return envelope(op, `<m:Items>${item(version, meeting)}</m:Items>`);
    if (op === "UpdateItem") version = "v2";
    return envelope(op, "");
  };
  return {
    calls,
    request,
    setMeeting: () => {
      meeting = true;
    },
  };
}

test("calendar validation: bounds, real dates, offset-aware times and exclusive all-day end", () => {
  assert.throws(() =>
    calendarRange.parse({ start: range.start, end: "2027-12-01T00:00:00Z" }),
  );
  assert.throws(() =>
    calendarDraft.parse({ ...input, start: "2026-11-13T09:00:00" }),
  );
  assert.throws(() =>
    calendarDraft.parse({
      ...input,
      all_day: true,
      start: "2026-02-30",
      end: "2026-03-02",
    }),
  );
  assert.throws(() => calendarDraft.parse({ ...input, end: input.start }));
  assert.equal(
    calendarDraft.parse({
      ...input,
      all_day: true,
      start: "2026-11-13",
      end: "2026-11-14",
    }).all_day,
    true,
  );
});

test("calendar write requests never trigger Scrum's automatic write reminder", async () => {
  const store = new Store(":memory:");
  let rounds = 0;
  const assistant = new Assistant(
    store,
    { url: "http://model.test", model: "test", timeout: 1000 },
    (async (url) => {
      if (String(url).endsWith("/api/show"))
        return Response.json({ capabilities: ["tools"] });
      rounds++;
      return Response.json({
        message: {
          role: "assistant",
          content:
            "Jag kan bara läsa din kalender. Gör ändringen under Kalender.",
        },
      });
    }) as typeof fetch,
  );
  try {
    const board = store.createBoard({ name: "Scrum", kind: "scrum" });
    const events: any[] = [];
    await assistant.chat(
      "Skapa en kalenderbokning i Exchange imorgon.",
      newSession(),
      (e) => events.push(e),
      undefined,
      { board_id: board.id },
    );
    assert.equal(rounds, 1);
    assert.match(events.find((e) => e.type === "done").message, /bara läsa/);
    assert.equal(store.list(board.id).length, 0);
  } finally {
    store.close();
  }
});

test("real curl transport verifies TLS, sends escaped credentials via stdin and transmits the complete SOAP body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-ews-tls-")),
    previous = process.env.CURL_CA_BUNDLE;
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "ca.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  let received = "",
    auth = "",
    action = "";
  const server = httpsServer(
    {
      key: readFileSync(join(dir, "key.pem")),
      cert: readFileSync(join(dir, "ca.pem")),
    },
    async (req, res) => {
      auth = req.headers.authorization ?? "";
      action = req.headers.soapaction as string;
      for await (const data of req) received += data;
      res.setHeader("Content-Type", "text/xml");
      res.end(envelope("CreateItem", ""));
    },
  );
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    process.env.CURL_CA_BUNDLE = join(dir, "ca.pem");
    const credentials = {
      ...account,
      auth: "basic" as const,
      endpoint: `https://127.0.0.1:${(server.address() as AddressInfo).port}/EWS/Exchange.asmx`,
    };
    const xml =
      '<s:Envelope><s:Body><m:CreateItem X="Y">quoted "data" &amp; newline\n</m:CreateItem></s:Body></s:Envelope>';
    await curlEws(credentials, xml);
    assert.equal(received, xml);
    assert.equal(
      auth,
      "Basic " +
        Buffer.from(credentials.username + ":" + credentials.password).toString(
          "base64",
        ),
    );
    assert.match(action, /\/CreateItem$/);
    delete process.env.CURL_CA_BUNDLE;
    await assert.rejects(curlEws(credentials, xml), /certifikat/);
  } finally {
    if (previous === undefined) delete process.env.CURL_CA_BUNDLE;
    else process.env.CURL_CA_BUNDLE = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Graph: paginated live reads, Stockholm/UTC conversion, no write transport and safe next links", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const event = {
    id: "graph/id",
    "@odata.etag": 'W/"v1"',
    subject: "Privat",
    body: { content: "Beskrivning" },
    start: { dateTime: "2026-11-13T09:00:00.0000000" },
    end: { dateTime: "2026-11-13T10:00:00" },
    isAllDay: false,
    type: "singleInstance",
    attendees: [] as unknown[],
  };
  const request = (async (url: string | URL | Request, init: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    if (init.method === "DELETE" || init.method === "PATCH")
      return new Response(null, { status: 204 });
    if (init.method === "POST") return Response.json(event, { status: 201 });
    if (u.pathname.endsWith("calendarView"))
      return Response.json({
        value: [event],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/calendarView?page=2",
      });
    return Response.json(event);
  }) as typeof fetch;
  let pages = 0;
  const provider = new GraphCalendar(
    "online",
    async () => "secret-access-token",
    (async (url, init) => {
      if (String(url).includes("page=2")) {
        pages++;
        return Response.json({
          value: [{ ...event, id: "recurring", type: "occurrence" }],
        });
      }
      return request(url, init);
    }) as typeof fetch,
  );
  const result = await provider.list(range.start, range.end);
  assert.equal(pages, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.events[0].start, "2026-11-13T08:00:00.000Z");
  assert.equal(result.events[1].read_only, true);
  await assert.rejects(provider.create(input), /skrivskyddad/);
  await assert.rejects(
    provider.update(event.id, event["@odata.etag"], input),
    /skrivskyddad/,
  );
  await assert.rejects(
    provider.delete(event.id, event["@odata.etag"]),
    /skrivskyddad/,
  );
  assert.ok(calls.every((c) => c.init.method === "GET"));
  const evil = new GraphCalendar("online", async () => "token", (async () =>
    Response.json({
      value: [],
      "@odata.nextLink": "https://evil.example/steal",
    })) as typeof fetch);
  await assert.rejects(evil.list(range.start, range.end), /sidadress/);
});

test("EWS: expands CalendarView, decodes XML, escapes writes, checks ChangeKey and protects recurring meetings", async () => {
  const fake = ewsFake(),
    provider = new EwsCalendar("job", account, fake.request);
  const result = await provider.list(range.start, range.end);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].start, "2026-11-13T08:00:00.000Z");
  assert.match(fake.calls[0].xml, /CalendarView/);
  assert.match(fake.calls[0].xml, /TimeZoneContext/);
  assert.match((await provider.get("ews-id")).description, /& innehåll/);
  await provider.create(input);
  assert.match(fake.calls.at(-1)!.xml, /Boka &lt;tid&gt; &amp; planera/);
  assert.match(fake.calls.at(-1)!.xml, /SendMeetingInvitations="SendToNone"/);
  await assert.rejects(provider.update("ews-id", "old", input), /ändrats/);
  await provider.update("ews-id", "v1", input);
  assert.match(fake.calls.at(-1)!.xml, /NeverOverwrite/);
  await provider.delete("ews-id", "v2");
  assert.match(fake.calls.at(-1)!.xml, /MoveToDeletedItems/);
  fake.setMeeting();
  await assert.rejects(provider.delete("ews-id", "v2"), /Outlook/);
  const recurring = new EwsCalendar("job", account, async () =>
    envelope(
      "GetItem",
      `<m:Items>${item("v1", false, "Occurrence")}</m:Items>`,
    ),
  );
  assert.equal((await recurring.get("ews-id")).read_only, true);
  const bad = new EwsCalendar(
    "job",
    account,
    async () => '<!DOCTYPE x [<!ENTITY e "unsafe">]><x/>',
  );
  await assert.rejects(bad.get("x"), /XML/);
  const denied = new EwsCalendar("job", account, async () =>
    envelope("GetItem", "", "ErrorAccessDenied"),
  );
  await assert.rejects(denied.get("x"), /ErrorAccessDenied/);
});

test("accounts: encryption at rest, restart, missing key recovery, per-account partial errors and AI access revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-calendar-")),
    path = join(dir, "kanban.sqlite"),
    fake = ewsFake();
  let store = new Store(path),
    calendar = new CalendarService(store, { ews: fake.request });
  try {
    const a = await calendar.add(account),
      b = await calendar.add({
        ...account,
        name: "Privat",
        username: "private-user",
      });
    const raw = JSON.stringify(
      store.db.prepare("SELECT * FROM calendar_accounts").all(),
    );
    assert.ok(!raw.includes(account.password));
    assert.ok(!raw.includes(account.username));
    assert.equal(statSync(join(dir, "calendar.key")).mode & 0o777, 0o600);
    calendar.permissions(b.id, { allow_ai: false });
    assert.deepEqual(
      calendar.accounts(true).map((x) => x.id),
      [a.id],
    );
    await assert.rejects(
      calendar.get(b.id, "ews-id", true),
      /inte tillgängligt/,
    );
    calendar.close();
    store.close();
    store = new Store(path);
    calendar = new CalendarService(store, { ews: fake.request });
    assert.equal(calendar.accounts().length, 2);
    assert.equal((await calendar.list(range)).events.length, 2);
    const mixed = new CalendarService(store, {
      ews: async (credentials, xml) => {
        if (
          credentials.username === account.username &&
          xml.includes("FindItem")
        )
          throw new Error("raw-password-must-not-leak");
        return fake.request(credentials, xml);
      },
    });
    const failure = await mixed.list(range);
    assert.equal(failure.errors.length, 1);
    assert.equal(failure.events.length, 1);
    assert.ok(!JSON.stringify(failure).includes("raw-password"));
    mixed.close();
    calendar.remove(b.id);
    assert.equal(calendar.accounts().length, 1);
    const key = readFileSync(join(dir, "calendar.key"));
    assert.equal(key.length, 32);
    unlinkSync(join(dir, "calendar.key"));
    assert.throws(() => new CalendarService(store), /saknas/);
  } finally {
    calendar.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP human CRUD is guarded; AI has only read tools and its calendar output logs exclude event content", async () => {
  const store = new Store(":memory:"),
    fake = ewsFake();
  let next = 0,
    accountId = "";
  const assistant = new Assistant(
    store,
    { url: "http://model.test", model: "test", timeout: 1000 },
    (async (url) =>
      String(url).endsWith("/api/show")
        ? Response.json({ capabilities: ["tools"] })
        : Response.json({
            message:
              next++ === 0
                ? {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        function: {
                          name: "list_calendar_events",
                          arguments: { ...range, account_id: accountId },
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content:
                      "Du har Jobbmöte den 13 november kl. 09 i jobbkalendern.",
                  },
          })) as typeof fetch,
  );
  const calendar = (assistant.calendar = new CalendarService(
    store,
    { key: randomBytes(32), ews: fake.request },
    (e, d) => assistant.knowledge.log(e, d),
  ));
  const app = createApp(store, assistant),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/calendar`;
  const send = (
    path: string,
    method: string,
    body: unknown,
    manual = true,
    origin?: string,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(manual ? { "X-Calendar-Action": "manual" } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await send("/accounts", "POST", account, false)).status, 403);
    assert.equal(
      (await send("/accounts", "POST", account, true, "http://other.example"))
        .status,
      403,
    );
    const added = await send("/accounts", "POST", account);
    assert.equal(added.status, 201);
    accountId = (await added.json()).account.id;
    assert.equal(
      (await send(`/accounts/${accountId}/events`, "POST", input)).status,
      201,
    );
    assert.equal(
      (
        await send(`/accounts/${accountId}/events/ews-id`, "PATCH", {
          version: "wrong",
          event: input,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await send(`/accounts/${accountId}/events/ews-id`, "PATCH", {
          version: "v1",
          event: input,
        })
      ).status,
      200,
    );
    assert.equal(
      (await send(`/accounts/${accountId}/events/ews-id`, "DELETE", {})).status,
      400,
    );
    assert.equal(
      (
        await send(`/accounts/${accountId}/events/ews-id`, "DELETE", {
          version: "v2",
        })
      ).status,
      200,
    );
    const toolNames = tools
      .map((t) => t.function.name)
      .filter((x) => x.includes("calendar"));
    assert.deepEqual(toolNames.sort(), [
      "get_calendar_event",
      "list_calendar_accounts",
      "list_calendar_events",
    ]);
    for (const name of [
      "create_calendar_event",
      "update_calendar_event",
      "delete_calendar_event",
      "request_calendar_write",
    ])
      await assert.rejects(
        assistant.executeTool(name, input, newSession()),
        /inte tillåtet/,
      );
    const before = fake.calls.filter((c) =>
      /Create|Update|Delete/.test(c.operation),
    ).length;
    const output: any[] = [];
    await assistant.chat(
      "Vad har jag i kalendern i november?",
      newSession(),
      (e) => output.push(e),
    );
    assert.match(output.find((e) => e.type === "done").message, /Jobbmöte/);
    assert.equal(
      fake.calls.filter((c) => /Create|Update|Delete/.test(c.operation)).length,
      before,
    );
    const logs = JSON.stringify(assistant.knowledge.logs({ limit: 100 }));
    assert.ok(!logs.includes(account.password));
    assert.ok(!logs.includes("Privat beskrivning"));
    assert.match(logs, /calendar.read/);
    calendar.permissions(accountId, { allow_ai: false });
    await assert.rejects(
      assistant.executeTool(
        "get_calendar_event",
        { account_id: accountId, event_id: "ews-id" },
        newSession(),
      ),
      /inte tillgängligt/,
    );
  } finally {
    calendar.close();
    await app.locals.jobQueue.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
