import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphSync, EwsSync } from "../server/sync-providers.js";
import type { SyncFolder } from "../shared/sync.js";
const start = "2026-10-14T00:00:00Z",
  end = "2027-02-11T00:00:00Z";
const inbox: SyncFolder = {
  id: "inbox-id",
  name: "Inkorg",
  kind: "mail",
  role: "incoming",
};
const eventFolder: SyncFolder = {
  id: "calendar-id",
  name: "Möten",
  kind: "calendar",
  role: "incoming",
};

test("Graph sync enumerates nested mail folders/calendars, inherits spam/deleted roles and follows opaque delta cursors beyond old offsets", async () => {
  const requests: URL[] = [];
  const reader = new GraphSync(async () => "synthetic-token", (async (
    input,
    init,
  ) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(init?.method, "GET");
    assert.match(
      (init?.headers as Record<string, string>).Prefer,
      /ImmutableId/,
    );
    const suffix = url.pathname.slice("/v1.0/me".length);
    if (
      [
        "/mailFolders/sentitems",
        "/mailFolders/drafts",
        "/mailFolders/junkemail",
        "/mailFolders/deleteditems",
      ].includes(suffix)
    )
      return Response.json({ id: suffix.split("/").pop() });
    if (suffix === "") return Response.json({ mail: "owner@example.test" });
    if (suffix === "/mailFolders")
      return Response.json({
        value: [
          { id: "inbox-id", displayName: "Inkorg", childFolderCount: 0 },
          { id: "junkemail", displayName: "Skräppost", childFolderCount: 1 },
        ],
      });
    if (suffix === "/mailFolders/junkemail/childFolders")
      return Response.json({
        value: [{ id: "junk-child", displayName: "Sorterat skräp" }],
      });
    if (suffix === "/calendars")
      return Response.json({
        value: [
          { id: "calendar-id", name: "Möten" },
          { id: "second-calendar", name: "Privat" },
        ],
      });
    if (suffix.endsWith("messages/delta")) {
      if (url.searchParams.has("$skiptoken"))
        return Response.json({
          value: [{ id: "removed-id", "@removed": { reason: "deleted" } }],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/mailFolders/inbox-id/messages/delta?$deltatoken=opaque",
        });
      return Response.json({
        value: [
          {
            id: "immutable-id",
            internetMessageId: "<stable@example.test>",
            subject: "Rapport",
            body: {
              contentType: "html",
              content:
                "<script>doBadThing()</script><p>Kan du skicka rapporten?</p>",
            },
            receivedDateTime: "2026-11-13T09:00:00Z",
            conversationId: "thread",
          },
        ],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/inbox-id/messages/delta?$skiptoken=5001",
      });
    }
    if (suffix.endsWith("calendarView"))
      return Response.json({
        value: [
          {
            id: "event",
            subject: "Projektmöte",
            start: {
              dateTime: "2026-11-14T10:00:00",
              timeZone: "W. Europe Standard Time",
            },
            end: {
              dateTime: "2026-11-14T11:00:00",
              timeZone: "W. Europe Standard Time",
            },
            isCancelled: true,
          },
        ],
      });
    throw new Error("Unexpected synthetic Graph request");
  }) as typeof fetch);
  const folders = await reader.folders();
  assert.equal(folders.length, 5);
  assert.equal(folders.find((x) => x.id === "junk-child")?.role, "junk");
  const first = await reader.page(inbox, null, start, end);
  assert.equal(first.complete, false);
  assert.equal(first.documents[0].identity, "<stable@example.test>");
  assert.ok(!first.documents[0].body.includes("doBadThing"));
  const second = await reader.page(inbox, first.cursor, start, end);
  assert.equal(second.complete, true);
  assert.deepEqual(second.removed, ["removed-id"]);
  assert.match(second.cursor!, /deltatoken/);
  const calendar = await reader.page(eventFolder, null, start, end);
  assert.equal(calendar.documents[0].starts_at, "2026-11-14T09:00:00.000Z");
  assert.equal(calendar.documents[0].cancelled, true);
  assert.ok(requests.every((x) => x.origin === "https://graph.microsoft.com"));
});

test("Graph range scans preserve server filters and refuse external next links", async () => {
  let unsafe = false;
  const reader = new GraphSync(async () => "token", (async (input) => {
    const url = new URL(String(input));
    assert.equal(
      url.searchParams.get("$filter"),
      `receivedDateTime ge ${start} and receivedDateTime lt ${end}`,
    );
    return Response.json({
      value: [],
      ...(unsafe
        ? { "@odata.nextLink": "https://external.invalid/steal" }
        : {}),
    });
  }) as typeof fetch);
  assert.equal(
    (await reader.page(inbox, null, start, end, true)).complete,
    true,
  );
  unsafe = true;
  await assert.rejects(
    reader.page(inbox, null, start, end, true),
    /Ogiltig synkmarkör/,
  );
});

const envelope = (op: string, body: string, code = "NoError") =>
  `<s:Envelope xmlns:s="urn:s"><s:Body><${op}Response><ResponseMessages><${op}ResponseMessage><ResponseCode>${code}</ResponseCode>${body}</${op}ResponseMessage></ResponseMessages></${op}Response></s:Body></s:Envelope>`;
const message = `<Message><ItemId Id="message-id"/><InternetMessageId>&lt;stable@example.test&gt;</InternetMessageId><ConversationId Id="conversation"/><Subject>Fråga</Subject><DateTimeReceived>2026-11-13T10:00:00Z</DateTimeReceived><Body BodyType="Text">Kan du svara på frågan?</Body><From><Mailbox><EmailAddress>sender@example.test</EmailAddress></Mailbox></From></Message>`;
test("EWS sync uses read operations, escaped cursors, full GetItem bodies and recursive role mapping", async () => {
  const operations: string[] = [];
  const reader = new EwsSync(
    "account",
    {
      endpoint: "https://exchange.test/EWS/Exchange.asmx",
      username: "user",
      password: "synthetic",
      auth: "ntlm",
    },
    async (_credentials, xml) => {
      const op = xml.match(/<m:(\w+) /)![1];
      operations.push(op);
      if (op === "GetFolder")
        return `<s:Envelope xmlns:s="urn:s"><s:Body><GetFolderResponse><ResponseMessages>${["sent", "drafts", "junk", "deleted"].map((id) => `<GetFolderResponseMessage><ResponseCode>NoError</ResponseCode><Folders><Folder><FolderId Id="${id}"/></Folder></Folders></GetFolderResponseMessage>`).join("")}</ResponseMessages></GetFolderResponse></s:Body></s:Envelope>`;
      if (op === "FindFolder")
        return envelope(
          op,
          '<RootFolder IncludesLastItemInRange="true"><Folders><Folder><FolderId Id="inbox-id"/><FolderClass>IPF.Note</FolderClass></Folder><Folder><FolderId Id="child-junk"/><ParentFolderId Id="junk"/><FolderClass>IPF.Note</FolderClass></Folder><CalendarFolder><FolderId Id="calendar-id"/><FolderClass>IPF.Appointment</FolderClass></CalendarFolder></Folders></RootFolder>',
        );
      if (op === "SyncFolderItems") {
        assert.match(xml, /<m:SyncState>state&amp;one<\/m:SyncState>/);
        return envelope(
          op,
          '<SyncState>state-two</SyncState><IncludesLastItemInRange>true</IncludesLastItemInRange><Changes><Create><Message><ItemId Id="message-id"/></Message></Create><Delete><ItemId Id="removed"/></Delete></Changes>',
        );
      }
      if (op === "GetItem") return envelope(op, `<Items>${message}</Items>`);
      throw new Error("Unexpected EWS mutation");
    },
  );
  const folders = await reader.folders();
  assert.equal(folders.find((f) => f.id === "child-junk")?.role, "junk");
  const page = await reader.page(inbox, "state&one", start, end);
  assert.equal(page.complete, true);
  assert.equal(page.cursor, "state-two");
  assert.equal(page.documents[0].body, "Kan du svara på frågan?");
  assert.deepEqual(page.removed, ["removed"]);
  assert.ok(
    operations.every((op) =>
      ["GetFolder", "FindFolder", "SyncFolderItems", "GetItem"].includes(op),
    ),
  );
});

test("EWS calendar splits truncated windows, expands recurring instances and reads details without silently dropping entries", async () => {
  let lists = 0;
  const reader = new EwsSync(
    "account",
    {
      endpoint: "https://exchange.test/EWS/Exchange.asmx",
      username: "user",
      password: "synthetic",
      auth: "ntlm",
    },
    async (_credentials, xml) => {
      const op = xml.match(/<m:(\w+) /)![1];
      if (op === "FindItem")
        return envelope(
          op,
          lists++ === 0
            ? '<RootFolder IncludesLastItemInRange="false"><Items/></RootFolder>'
            : '<RootFolder IncludesLastItemInRange="true"><Items><CalendarItem><ItemId Id="occurrence"/></CalendarItem></Items></RootFolder>',
        );
      assert.equal(op, "GetItem");
      return envelope(
        op,
        '<Items><CalendarItem><ItemId Id="occurrence"/><Subject>Möte</Subject><Start>2026-11-14T10:00:00</Start><End>2026-11-14T11:00:00</End><Body BodyType="Text">Förbered rapporten.</Body></CalendarItem></Items>',
      );
    },
  );
  let page = await reader.page(eventFolder, null, start, end);
  assert.equal(page.documents.length, 0);
  assert.equal(page.complete, false);
  page = await reader.page(eventFolder, page.cursor, start, end);
  assert.equal(page.documents.length, 1);
  assert.equal(page.complete, false);
  assert.equal(page.documents[0].body, "Förbered rapporten.");
  page = await reader.page(eventFolder, page.cursor, start, end);
  assert.equal(page.complete, true);
  assert.equal(page.documents[0].starts_at, "2026-11-14T09:00:00.000Z");
});
