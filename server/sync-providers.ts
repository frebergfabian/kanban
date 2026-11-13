import { DateTime } from "luxon";
import { GraphReader } from "./graph.js";
import { EwsClient, array, text, escapeXml } from "./calendar-providers.js";
import { HttpError } from "./store.js";
import type { SyncDocument, SyncFolder, SyncPage } from "../shared/sync.js";

export interface SyncReader {
  folders(): Promise<SyncFolder[]>;
  page(
    folder: SyncFolder,
    cursor: string | null,
    start: string,
    end: string,
    scan?: boolean,
  ): Promise<SyncPage>;
}
const plain = (value: unknown) =>
  String(value ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const iso = (value: string, zone = "Europe/Stockholm") =>
  DateTime.fromISO(value, {
    zone: zone === "W. Europe Standard Time" ? "Europe/Stockholm" : zone,
  })
    .toUTC()
    .toISO() ?? "";
const graphFields =
  "id,internetMessageId,conversationId,subject,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isDraft";
const graphEventFields =
  "id,iCalUId,subject,body,start,end,isCancelled,organizer,attendees,webLink";
const graphNext = (value: unknown): string | null => {
  if (!value) return null;
  const url = new URL(String(value));
  if (
    url.origin !== "https://graph.microsoft.com" ||
    !url.pathname.startsWith("/v1.0/me/")
  )
    throw new HttpError(502, "Ogiltig synkmarkör från Graph.");
  return url.toString();
};
export class GraphSync implements SyncReader {
  private graph: GraphReader;
  constructor(token: () => Promise<string>, request?: typeof fetch) {
    this.graph = new GraphReader(token, request);
  }
  async folders() {
    const role = new Map<string, SyncFolder["role"]>();
    for (const [name, kind] of [
      ["sentitems", "sent"],
      ["drafts", "drafts"],
      ["junkemail", "junk"],
      ["deleteditems", "deleted"],
    ] as const) {
      const result = await this.graph.get(`me/mailFolders/${name}?$select=id`);
      role.set(result.id, kind);
    }
    const profile = await this.graph.get("me?$select=mail,userPrincipalName");
    const owner = String(profile.mail || profile.userPrincipalName || "");
    const folders: SyncFolder[] = [],
      seen = new Set<string>();
    const paths: { url: string; inherited: SyncFolder["role"] }[] = [
      { url: "me/mailFolders?$top=100", inherited: "incoming" },
    ];
    while (paths.length) {
      const current = paths.shift()!;
      const result = await this.graph.get(current.url);
      if (!Array.isArray(result.value))
        throw new HttpError(502, "Graph saknar mapplista.");
      for (const folder of result.value) {
        if (seen.has(folder.id)) continue;
        seen.add(folder.id);
        const inherited = role.get(folder.id) ?? current.inherited;
        folders.push({
          id: folder.id,
          name: folder.displayName || "Mapp",
          kind: "mail",
          role: inherited,
          owner,
        });
        if (folder.childFolderCount)
          paths.push({
            url: `me/mailFolders/${encodeURIComponent(folder.id)}/childFolders?$top=100`,
            inherited,
          });
      }
      const next = graphNext(result["@odata.nextLink"]);
      if (next) paths.push({ url: next, inherited: current.inherited });
    }
    let path: string | null = "me/calendars?$select=id,name&$top=100";
    while (path) {
      const result = await this.graph.get(path);
      if (!Array.isArray(result.value))
        throw new HttpError(502, "Graph saknar kalenderlista.");
      for (const c of result.value)
        folders.push({
          id: c.id,
          name: c.name || "Kalender",
          kind: "calendar",
          role: "incoming",
          owner,
        });
      path = graphNext(result["@odata.nextLink"]);
    }
    return folders;
  }
  private document(item: any, folder: SyncFolder): SyncDocument {
    const calendar = folder.kind === "calendar";
    const body =
      item.body?.contentType?.toLowerCase() === "html"
        ? plain(item.body.content)
        : String(item.body?.content ?? "");
    const starts = calendar
      ? iso(item.start?.dateTime ?? "", item.start?.timeZone)
      : null;
    return {
      kind: folder.kind,
      external_id: item.id,
      identity: calendar ? item.id : String(item.internetMessageId || item.id),
      thread_id: calendar ? item.id : item.conversationId || null,
      title: String(item.subject || "(Utan ämne)").slice(0, 500),
      body: body.slice(0, 30000),
      body_truncated: body.length > 30000,
      occurred_at: calendar
        ? starts!
        : item.receivedDateTime || item.sentDateTime || "",
      sender: String(
        (calendar ? item.organizer : item.from)?.emailAddress?.address || "",
      ),
      recipients: calendar
        ? (item.attendees ?? []).map((x: any) => x.emailAddress?.address || "")
        : [...(item.toRecipients ?? []), ...(item.ccRecipients ?? [])].map(
            (x: any) => x.emailAddress?.address || "",
          ),
      owner: folder.owner || "",
      folder: folder.name,
      role: item.isDraft ? "drafts" : folder.role,
      url: item.webLink || null,
      starts_at: starts,
      ends_at: calendar
        ? iso(item.end?.dateTime ?? "", item.end?.timeZone)
        : null,
      cancelled: !!item.isCancelled,
    };
  }
  async page(
    folder: SyncFolder,
    cursor: string | null,
    start: string,
    end: string,
    scan = false,
  ): Promise<SyncPage> {
    const base = `me/${folder.kind === "calendar" ? "calendars" : "mailFolders"}/${encodeURIComponent(folder.id)}`;
    const params = new URLSearchParams({
      $select:
        folder.kind === "calendar"
          ? graphEventFields
          : scan
            ? graphFields
            : graphFields.replace(",body,", ","),
    });
    if (folder.kind === "calendar") {
      params.set("startDateTime", start);
      params.set("endDateTime", end);
      params.set("$top", "25");
    } else if (scan) {
      params.set(
        "$filter",
        `receivedDateTime ge ${start} and receivedDateTime lt ${end}`,
      );
      params.set("$orderby", "receivedDateTime desc");
      params.set("$top", "25");
    }
    const path =
      cursor ||
      `${base}/${folder.kind === "calendar" ? "calendarView" : scan ? "messages" : "messages/delta"}?${params}`;
    // An expired delta cursor triggers a fresh baseline. Hashes/receipts retain idempotency.
    let result: any;
    try {
      result = await this.graph.get(path);
    } catch (e) {
      if (
        cursor &&
        folder.kind === "mail" &&
        !scan &&
        e instanceof HttpError &&
        /HTTP 410/.test(e.message)
      )
        return this.page(folder, null, start, end, scan);
      throw e;
    }
    if (!Array.isArray(result.value))
      throw new HttpError(502, "Graph saknar synkresultat.");
    const next = graphNext(result["@odata.nextLink"]),
      delta = graphNext(result["@odata.deltaLink"]);
    if (folder.kind === "mail" && !scan && !next && !delta)
      throw new HttpError(502, "Graph saknar delta-markör.");
    const items = result.value.filter((x: any) => !x["@removed"]);
    const documents: SyncDocument[] = [];
    for (let item of items) {
      if (folder.kind === "mail" && !scan) {
        const received = Date.parse(
          item.receivedDateTime || item.sentDateTime || "",
        );
        if (Number.isFinite(received) && received < Date.parse(start)) continue;
        if (!item.body) {
          try {
            item = await this.graph.get(
              `me/messages/${encodeURIComponent(item.id)}?$select=${graphFields}`,
            );
          } catch (e) {
            if (e instanceof HttpError && /HTTP 404/.test(e.message)) continue;
            throw e;
          }
        }
      }
      documents.push(this.document(item, folder));
    }
    return {
      documents,
      removed: result.value
        .filter((x: any) => x["@removed"])
        .map((x: any) => x.id),
      cursor: next || delta,
      complete: !next,
    };
  }
}

type CalendarCursor = { windows: [string, string][]; ids: string[] };
export class EwsSync extends EwsClient implements SyncReader {
  async folders() {
    const role = new Map<string, SyncFolder["role"]>();
    const names = ["sentitems", "drafts", "junkemail", "deleteditems"];
    const result = await this.call(
      "GetFolder",
      `<m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds>${names.map((x) => `<t:DistinguishedFolderId Id="${x}"/>`).join("")}</m:FolderIds>`,
    );
    result.forEach((x, i) => {
      const id = x.Folders?.Folder?.FolderId?.Id;
      if (id) role.set(id, (["sent", "drafts", "junk", "deleted"] as const)[i]);
    });
    const folders: SyncFolder[] = [],
      parents = new Map<string, string>();
    let offset = 0;
    for (;;) {
      const [page] = await this.call(
        "FindFolder",
        `<m:FolderShape><t:BaseShape>Default</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="folder:FolderClass"/><t:FieldURI FieldURI="folder:ParentFolderId"/></t:AdditionalProperties></m:FolderShape><m:IndexedPageFolderView MaxEntriesReturned="100" Offset="${offset}" BasePoint="Beginning"/><m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds>`,
        'Traversal="Deep"',
      );
      if (!page.RootFolder) throw new HttpError(502, "EWS saknar mapplista.");
      for (const f of [
        ...array(page.RootFolder.Folders?.Folder),
        ...array(page.RootFolder.Folders?.CalendarFolder),
      ]) {
        const klass = text(f.FolderClass);
        if (klass && !/^IPF\.(Note|Appointment)(\.|$)/.test(klass)) continue;
        const kind = klass.startsWith("IPF.Appointment") ? "calendar" : "mail";
        if (f.ParentFolderId?.Id)
          parents.set(f.FolderId.Id, f.ParentFolderId.Id);
        folders.push({
          id: f.FolderId.Id,
          name: text(f.DisplayName) || "Mapp",
          kind,
          role: role.get(f.FolderId.Id) ?? "incoming",
        });
      }
      if (page.RootFolder.IncludesLastItemInRange !== "false") break;
      const next = Number(page.RootFolder.IndexedPagingOffset);
      if (!Number.isSafeInteger(next) || next <= offset)
        throw new HttpError(502, "Ogiltig EWS-mappmarkör.");
      offset = next;
    }
    for (const folder of folders) {
      const seen = new Set<string>();
      let id: string | undefined = folder.id;
      while (id && !seen.has(id)) {
        seen.add(id);
        if (role.has(id)) {
          folder.role = role.get(id)!;
          break;
        }
        id = parents.get(id);
      }
    }
    return folders;
  }
  private documents(items: any, folder: SyncFolder): SyncDocument[] {
    const kinds =
      folder.kind === "calendar"
        ? ["CalendarItem"]
        : [
            "Message",
            "MeetingRequest",
            "MeetingResponse",
            "MeetingCancellation",
          ];
    return kinds
      .flatMap((k) => array(items?.[k]))
      .map((item) => {
        const body =
          item.Body?.BodyType === "HTML"
            ? plain(text(item.Body))
            : text(item.Body);
        const calendar = folder.kind === "calendar";
        const starts = calendar ? iso(text(item.Start)) : null;
        return {
          kind: folder.kind,
          external_id: item.ItemId.Id,
          identity: calendar
            ? item.ItemId.Id
            : text(item.InternetMessageId) || item.ItemId.Id,
          thread_id: calendar
            ? item.ItemId.Id
            : item.ConversationId?.Id || null,
          title: (text(item.Subject) || "(Utan ämne)").slice(0, 500),
          body: body.slice(0, 30000),
          body_truncated: body.length > 30000,
          occurred_at: calendar
            ? starts!
            : iso(text(item.DateTimeReceived || item.DateTimeSent)),
          sender: text(
            (calendar ? item.Organizer : item.From)?.Mailbox?.EmailAddress,
          ),
          recipients: calendar
            ? [
                ...array(item.RequiredAttendees?.Attendee),
                ...array(item.OptionalAttendees?.Attendee),
              ].map((x) => text(x.Mailbox?.EmailAddress))
            : [
                ...array(item.ToRecipients?.Mailbox),
                ...array(item.CcRecipients?.Mailbox),
              ].map((x) => text(x.EmailAddress)),
          owner: folder.owner || "",
          folder: folder.name,
          role: folder.role,
          url: null,
          starts_at: starts,
          ends_at: calendar ? iso(text(item.End)) : null,
          cancelled: item.IsCancelled === "true",
        };
      });
  }
  private async details(ids: string[], folder: SyncFolder) {
    if (!ids.length) return [];
    try {
      const pages = await this.call(
        "GetItem",
        `<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape><t:BodyType>Text</t:BodyType></m:ItemShape><m:ItemIds>${ids.map((id) => `<t:ItemId Id="${escapeXml(id)}"/>`).join("")}</m:ItemIds>`,
      );
      return pages.flatMap((p) => this.documents(p.Items, folder));
    } catch (e) {
      if (!(e instanceof HttpError) || !/ErrorItemNotFound/.test(e.message))
        throw e;
      if (ids.length === 1) return [];
      const found: SyncDocument[] = [];
      for (const id of ids) found.push(...(await this.details([id], folder)));
      return found;
    }
  }
  async page(
    folder: SyncFolder,
    cursor: string | null,
    start: string,
    end: string,
    scan = false,
  ): Promise<SyncPage> {
    if (folder.kind === "calendar")
      return this.calendarPage(folder, cursor, start, end);
    if (scan) {
      const offset = cursor ? Number(cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new HttpError(502, "Ogiltig EWS-sidmarkör.");
      const [page] = await this.call(
        "FindItem",
        `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="25" Offset="${offset}" BasePoint="Beginning"/><m:Restriction><t:And><t:IsGreaterThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived"/><t:FieldURIOrConstant><t:Constant Value="${escapeXml(start)}"/></t:FieldURIOrConstant></t:IsGreaterThanOrEqualTo><t:IsLessThan><t:FieldURI FieldURI="item:DateTimeReceived"/><t:FieldURIOrConstant><t:Constant Value="${escapeXml(end)}"/></t:FieldURIOrConstant></t:IsLessThan></t:And></m:Restriction><m:SortOrder><t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder></m:SortOrder><m:ParentFolderIds><t:FolderId Id="${escapeXml(folder.id)}"/></m:ParentFolderIds>`,
        'Traversal="Shallow"',
      );
      if (!page.RootFolder) throw new HttpError(502, "EWS saknar sökresultat.");
      const ids = [
        "Message",
        "MeetingRequest",
        "MeetingResponse",
        "MeetingCancellation",
      ]
        .flatMap((k) => array(page.RootFolder.Items?.[k]))
        .map((x) => x.ItemId.Id);
      const next = Number(
        page.RootFolder.IndexedPagingOffset ?? offset + ids.length,
      );
      const complete = page.RootFolder.IncludesLastItemInRange !== "false";
      if (!complete && (!Number.isSafeInteger(next) || next <= offset))
        throw new HttpError(502, "Ogiltig EWS-sidmarkör.");
      return {
        documents: await this.details(ids, folder),
        removed: [],
        cursor: complete ? null : String(next),
        complete,
      };
    }
    let page: any;
    try {
      [page] = await this.call(
        "SyncFolderItems",
        `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="item:DateTimeReceived"/><t:FieldURI FieldURI="item:DateTimeSent"/></t:AdditionalProperties></m:ItemShape><m:SyncFolderId><t:FolderId Id="${escapeXml(folder.id)}"/></m:SyncFolderId>${cursor ? `<m:SyncState>${escapeXml(cursor)}</m:SyncState>` : ""}<m:MaxChangesReturned>25</m:MaxChangesReturned><m:SyncScope>NormalItems</m:SyncScope>`,
      );
    } catch (e) {
      if (
        cursor &&
        e instanceof HttpError &&
        /ErrorInvalidSyncStateData/.test(e.message)
      )
        return this.page(folder, null, start, end, false);
      throw e;
    }
    if (!page.SyncState) throw new HttpError(502, "EWS saknar synktillstånd.");
    const ids = [...array(page.Changes?.Create), ...array(page.Changes?.Update)]
      .flatMap((x) =>
        [
          "Message",
          "MeetingRequest",
          "MeetingResponse",
          "MeetingCancellation",
        ].flatMap((k) => array(x[k])),
      )
      .filter((x) => {
        const received = Date.parse(text(x.DateTimeReceived || x.DateTimeSent));
        return !Number.isFinite(received) || received >= Date.parse(start);
      })
      .map((x) => x.ItemId.Id);
    return {
      documents: await this.details(ids, folder),
      removed: array(page.Changes?.Delete)
        .map((x) => x.ItemId?.Id)
        .filter(Boolean),
      cursor: text(page.SyncState),
      complete: page.IncludesLastItemInRange !== "false",
    };
  }
  private async calendarPage(
    folder: SyncFolder,
    cursor: string | null,
    start: string,
    end: string,
  ): Promise<SyncPage> {
    const state: CalendarCursor = cursor
      ? JSON.parse(cursor)
      : { windows: [[start, end]], ids: [] };
    if (!state.ids.length && state.windows.length) {
      const [from, to] = state.windows.shift()!;
      const [page] = await this.call(
        "FindItem",
        `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:CalendarView StartDate="${escapeXml(from)}" EndDate="${escapeXml(to)}" MaxEntriesReturned="100"/><m:ParentFolderIds><t:FolderId Id="${escapeXml(folder.id)}"/></m:ParentFolderIds>`,
        'Traversal="Shallow"',
      );
      if (!page.RootFolder)
        throw new HttpError(502, "EWS saknar kalenderresultat.");
      if (page.RootFolder.IncludesLastItemInRange === "false") {
        const mid = (Date.parse(from) + Date.parse(to)) / 2;
        if (Date.parse(to) - Date.parse(from) < 60000)
          throw new HttpError(
            502,
            "För många kalenderobjekt inom en minut; synken behöver ett smalare urval.",
          );
        const middle = new Date(mid).toISOString();
        state.windows.unshift([from, middle], [middle, to]);
      } else
        state.ids = array(page.RootFolder.Items?.CalendarItem).map(
          (x) => x.ItemId.Id,
        );
    }
    const ids = state.ids.splice(0, 25),
      complete = !state.ids.length && !state.windows.length;
    return {
      documents: await this.details(ids, folder),
      removed: [],
      cursor: complete ? null : JSON.stringify(state),
      complete,
    };
  }
}
