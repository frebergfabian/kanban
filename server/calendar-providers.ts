import { spawn } from "node:child_process";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { DateTime } from "luxon";
import type { CalendarDraft, CalendarEvent } from "../shared/calendar.js";
import { HttpError } from "./store.js";

const zone = "Europe/Stockholm",
  exchangeZone = "W. Europe Standard Time";
export interface CalendarProvider {
  list(
    start: string,
    end: string,
  ): Promise<{ events: CalendarEvent[]; truncated: boolean }>;
  get(id: string): Promise<CalendarEvent>;
  create(input: CalendarDraft): Promise<void>;
  update(id: string, version: string, input: CalendarDraft): Promise<void>;
  delete(id: string, version: string): Promise<void>;
}
const writable = (event: CalendarEvent, version: string) => {
  if (event.read_only)
    throw new HttpError(
      409,
      "Möten med deltagare och återkommande händelser visas här. Ändra dem i Outlook.",
    );
  if (!version || event.version !== version)
    throw new HttpError(
      409,
      "Händelsen har ändrats i Exchange. Läs in den igen innan du sparar.",
    );
};
function time(value: string, allDay: boolean): string {
  const dt = DateTime.fromISO(value, { zone });
  if (!dt.isValid)
    throw new HttpError(502, "Exchange returnerade ett ogiltigt datum.");
  return allDay ? dt.setZone(zone).toISODate()! : dt.toUTC().toISO()!;
}
const graphBody = (input: CalendarDraft) => ({
  subject: input.title,
  body: { contentType: "text", content: input.description },
  location: { displayName: input.location },
  isAllDay: input.all_day,
  start: {
    dateTime: input.all_day
      ? `${input.start}T00:00:00`
      : DateTime.fromISO(input.start).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    timeZone: input.all_day ? exchangeZone : "UTC",
  },
  end: {
    dateTime: input.all_day
      ? `${input.end}T00:00:00`
      : DateTime.fromISO(input.end).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    timeZone: input.all_day ? exchangeZone : "UTC",
  },
});
export class GraphCalendar implements CalendarProvider {
  constructor(
    private accountId: string,
    private token: () => Promise<string>,
    private request: typeof fetch = fetch,
  ) {}
  private async call(
    path: string,
    method = "GET",
    body?: unknown,
    version?: string,
  ): Promise<any> {
    const url = new URL(path, "https://graph.microsoft.com/v1.0/");
    if (
      url.origin !== "https://graph.microsoft.com" ||
      !url.pathname.startsWith("/v1.0/me/")
    )
      throw new HttpError(502, "Ogiltig Graph-sidadress.");
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          "Content-Type": "application/json",
          Prefer:
            'outlook.timezone="W. Europe Standard Time", outlook.body-content-type="text"',
          ...(version ? { "If-Match": version } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        "Kunde inte nå Microsoft Graph. Kontrollera nätverket och försök igen.",
      );
    }
    if (!response.ok)
      throw new HttpError(
        response.status === 412 ? 409 : 502,
        response.status === 401
          ? "Microsoft-inloggningen behöver förnyas. Anslut kontot igen."
          : response.status === 403
            ? "Microsoft nekade kalenderåtkomst. Kontrollera Calendars.ReadWrite och organisationens medgivande."
            : response.status === 412
              ? "Händelsen har ändrats. Läs in den igen."
              : `Microsoft Graph svarade med HTTP ${response.status}. Läs in kalendern innan du försöker igen.`,
      );
    return response.status === 204 ? undefined : response.json();
  }
  private event(item: any): CalendarEvent {
    const allDay = !!item.isAllDay;
    const recurring =
      !!item.recurrence ||
      ["occurrence", "exception", "seriesMaster"].includes(item.type);
    return {
      id: String(item.id),
      account_id: this.accountId,
      version: item["@odata.etag"] ?? item.changeKey ?? "",
      title: item.subject || "Utan rubrik",
      description: String(item.body?.content ?? item.bodyPreview ?? "").slice(
        0,
        10000,
      ),
      location: item.location?.displayName ?? "",
      start: time(item.start.dateTime, allDay),
      end: time(item.end.dateTime, allDay),
      all_day: allDay,
      read_only:
        recurring ||
        !!item.isMeeting ||
        !!item.isOnlineMeeting ||
        !!item.attendees?.length ||
        item.isOrganizer === false ||
        !!item.isCancelled,
      recurring,
      organizer: item.organizer?.emailAddress?.address ?? "",
      attendees: (item.attendees ?? []).map(
        (x: any) => x.emailAddress?.address ?? "",
      ),
      url: item.webLink ?? null,
    };
  }
  async list(start: string, end: string) {
    let path: string | undefined =
      `me/calendarView?${new URLSearchParams({ startDateTime: start, endDateTime: end, $top: "100", $orderby: "start/dateTime" })}`;
    const events: CalendarEvent[] = [];
    for (let page = 0; path && page < 5; page++) {
      const result = await this.call(path);
      events.push(...result.value.map((x: any) => this.event(x)));
      path = result["@odata.nextLink"];
    }
    return { events, truncated: !!path };
  }
  async get(id: string) {
    return this.event(await this.call(`me/events/${encodeURIComponent(id)}`));
  }
  async create(input: CalendarDraft) {
    await this.call("me/calendar/events", "POST", graphBody(input));
  }
  async update(id: string, version: string, input: CalendarDraft) {
    writable(await this.get(id), version);
    await this.call(
      `me/events/${encodeURIComponent(id)}`,
      "PATCH",
      graphBody(input),
      version,
    );
  }
  async delete(id: string, version: string) {
    writable(await this.get(id), version);
    await this.call(
      `me/events/${encodeURIComponent(id)}`,
      "DELETE",
      undefined,
      version,
    );
  }
}

export type EwsCredentials = {
  endpoint: string;
  username: string;
  password: string;
  auth: "ntlm" | "basic";
};
export type EwsTransport = (
  credentials: EwsCredentials,
  xml: string,
) => Promise<string>;
const quote = (s: string) =>
  '"' +
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r") +
  '"';
// libcurl supplies NTLMv2 without exposing credentials in argv, the environment or files.
// No redirects, no TLS bypass, no proxy forwarding of the job account's credentials.
export const curlEws: EwsTransport = (credentials, xml) =>
  new Promise((resolve, reject) => {
    const child = spawn("curl", ["--disable", "--config", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      tooLarge = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > 4_000_000) {
        tooLarge = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.on("error", () =>
      reject(new HttpError(502, "EWS kräver curl med NTLM-stöd på servern.")),
    );
    child.on("close", (code) => {
      if (tooLarge)
        return reject(
          new HttpError(
            502,
            "För stort EWS-svar. Välj ett kortare datumintervall.",
          ),
        );
      if (code !== 0)
        return reject(
          new HttpError(
            502,
            "Kunde inte ansluta till EWS. Kontrollera adress, certifikat och nätverk/VPN.",
          ),
        );
      const status = Number(out.slice(-3));
      if (status === 401 || status === 403)
        return reject(
          new HttpError(
            502,
            "EWS nekade inloggning. Kontrollera användarnamn, lösenord och tillåten autentisering med IT.",
          ),
        );
      if (status < 200 || status >= 300)
        return reject(new HttpError(502, `EWS svarade med HTTP ${status}.`));
      resolve(out.slice(0, -3));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      [
        "silent",
        "show-error",
        'proto = "=https"',
        'noproxy = "*"',
        "max-time = 30",
        "connect-timeout = 10",
        `url = ${quote(credentials.endpoint)}`,
        credentials.auth === "ntlm" ? "ntlm" : "basic",
        `user = ${quote(`${credentials.username}:${credentials.password}`)}`,
        'header = "Content-Type: text/xml; charset=utf-8"',
        'header = "User-Agent: Kanban-Calendar/1.0"',
        `header = ${quote(`SOAPAction: http://schemas.microsoft.com/exchange/services/2006/messages/${xml.match(/<m:(\w+) /)?.[1] ?? ""}`)}`,
        `data-binary = ${quote(xml)}`,
        'write-out = "%{http_code}"',
      ].join("\n") + "\n",
    );
  });
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const array = (value: any): any[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value: any): string => String(value?.["#text"] ?? value ?? "");
export class EwsCalendar implements CalendarProvider {
  constructor(
    private accountId: string,
    private credentials: EwsCredentials,
    private transport: EwsTransport = curlEws,
  ) {}
  private async call(operation: string, contents: string, attributes = "") {
    const xml = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"><s:Header><t:RequestServerVersion Version="Exchange2013_SP1"/><t:TimeZoneContext><t:TimeZoneDefinition Id="${exchangeZone}"/></t:TimeZoneContext></s:Header><s:Body><m:${operation} ${attributes}>${contents}</m:${operation}></s:Body></s:Envelope>`;
    const response = await this.transport(this.credentials, xml);
    if (
      response.length > 4_000_000 ||
      /<!DOCTYPE|<!ENTITY/i.test(response) ||
      XMLValidator.validate(response) !== true
    )
      throw new HttpError(502, "Ogiltigt XML-svar från EWS.");
    const parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: true,
      parseTagValue: false,
    }).parse(response);
    const message =
      parsed.Envelope?.Body?.[`${operation}Response`]?.ResponseMessages?.[
        `${operation}ResponseMessage`
      ];
    const messages = array(message);
    if (!messages.length)
      throw new HttpError(502, "EWS returnerade ett oväntat svar.");
    for (const item of messages)
      if (item.ResponseCode !== "NoError") {
        const code = text(item.ResponseCode);
        throw new HttpError(
          /ChangeKey|Conflict|Irresolvable/i.test(code) ? 409 : 502,
          `EWS: ${code.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 100)}. Läs in kalendern igen och kontrollera kontots rättigheter.`,
        );
      }
    return messages;
  }
  private event(item: any): CalendarEvent {
    const allDay = item.IsAllDayEvent === "true",
      recurring =
        !!item.Recurrence ||
        ["Occurrence", "Exception", "RecurringMaster"].includes(
          item.CalendarItemType,
        );
    return {
      id: item.ItemId.Id,
      account_id: this.accountId,
      version: item.ItemId.ChangeKey ?? "",
      title: text(item.Subject) || "Utan rubrik",
      description: text(item.Body).slice(0, 10000),
      location: text(item.Location),
      start: time(text(item.Start), allDay),
      end: time(text(item.End), allDay),
      all_day: allDay,
      recurring,
      read_only:
        recurring ||
        item.IsMeeting === "true" ||
        item.IsCancelled === "true" ||
        !!item.RequiredAttendees ||
        !!item.OptionalAttendees,
      organizer: text(
        item.Organizer?.Mailbox?.EmailAddress ?? item.Organizer?.Mailbox?.Name,
      ),
      attendees: [
        ...array(item.RequiredAttendees?.Attendee),
        ...array(item.OptionalAttendees?.Attendee),
      ].map((x) => text(x.Mailbox?.EmailAddress)),
      url: null,
    };
  }
  async list(start: string, end: string) {
    const fields = [
      "item:Subject",
      "calendar:Start",
      "calendar:End",
      "calendar:IsAllDayEvent",
      "calendar:Location",
      "calendar:CalendarItemType",
      "calendar:IsMeeting",
      "calendar:IsCancelled",
    ];
    const [result] = await this.call(
      "FindItem",
      `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${fields.map((x) => `<t:FieldURI FieldURI="${x}"/>`).join("")}</t:AdditionalProperties></m:ItemShape><m:CalendarView StartDate="${escapeXml(start)}" EndDate="${escapeXml(end)}" MaxEntriesReturned="500"/><m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds>`,
      'Traversal="Shallow"',
    );
    if (!result.RootFolder)
      throw new HttpError(502, "EWS saknar kalenderresultat.");
    return {
      events: array(result.RootFolder.Items?.CalendarItem).map((x) =>
        this.event(x),
      ),
      truncated: result.RootFolder.IncludesLastItemInRange === "false",
    };
  }
  async get(id: string) {
    const [result] = await this.call(
      "GetItem",
      `<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape><t:BodyType>Text</t:BodyType></m:ItemShape><m:ItemIds><t:ItemId Id="${escapeXml(id)}"/></m:ItemIds>`,
    );
    if (!result.Items?.CalendarItem)
      throw new HttpError(502, "EWS hittade inte händelsen.");
    return this.event(result.Items.CalendarItem);
  }
  private properties(input: CalendarDraft) {
    return [
      ["item:Subject", `<t:Subject>${escapeXml(input.title)}</t:Subject>`],
      [
        "item:Body",
        `<t:Body BodyType="Text">${escapeXml(input.description)}</t:Body>`,
      ],
      [
        "calendar:Start",
        `<t:Start>${escapeXml(input.all_day ? `${input.start}T00:00:00` : input.start)}</t:Start>`,
      ],
      [
        "calendar:End",
        `<t:End>${escapeXml(input.all_day ? `${input.end}T00:00:00` : input.end)}</t:End>`,
      ],
      [
        "calendar:IsAllDayEvent",
        `<t:IsAllDayEvent>${input.all_day}</t:IsAllDayEvent>`,
      ],
      [
        "calendar:Location",
        `<t:Location>${escapeXml(input.location)}</t:Location>`,
      ],
    ];
  }
  async create(input: CalendarDraft) {
    await this.call(
      "CreateItem",
      `<m:SavedItemFolderId><t:DistinguishedFolderId Id="calendar"/></m:SavedItemFolderId><m:Items><t:CalendarItem>${this.properties(
        input,
      )
        .map((x) => x[1])
        .join(
          "",
        )}<t:StartTimeZone Id="${exchangeZone}"/><t:EndTimeZone Id="${exchangeZone}"/></t:CalendarItem></m:Items>`,
      'SendMeetingInvitations="SendToNone"',
    );
  }
  async update(id: string, version: string, input: CalendarDraft) {
    writable(await this.get(id), version);
    await this.call(
      "UpdateItem",
      `<m:ItemChanges><t:ItemChange><t:ItemId Id="${escapeXml(id)}" ChangeKey="${escapeXml(version)}"/><t:Updates>${this.properties(
        input,
      )
        .map(
          ([uri, value]) =>
            `<t:SetItemField><t:FieldURI FieldURI="${uri}"/><t:CalendarItem>${value}</t:CalendarItem></t:SetItemField>`,
        )
        .join("")}</t:Updates></t:ItemChange></m:ItemChanges>`,
      'ConflictResolution="NeverOverwrite" SendMeetingInvitationsOrCancellations="SendToNone"',
    );
  }
  async delete(id: string, version: string) {
    writable(await this.get(id), version);
    await this.call(
      "DeleteItem",
      `<m:ItemIds><t:ItemId Id="${escapeXml(id)}" ChangeKey="${escapeXml(version)}"/></m:ItemIds>`,
      'DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToNone" AffectedTaskOccurrences="SpecifiedOccurrenceOnly"',
    );
  }
}
