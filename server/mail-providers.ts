import type {
  MailAddress,
  MailDetail,
  MailMessage,
  MailPage,
  MailSearch,
} from "../shared/mail.js";
import { EwsClient, escapeXml, array, text } from "./calendar-providers.js";
import { GraphReader } from "./graph.js";
import { HttpError } from "./store.js";

export interface MailReader {
  search(input: MailSearch): Promise<MailPage>;
  get(id: string): Promise<MailDetail>;
}
const address = (x: any): MailAddress => ({
  name: String(x?.name ?? ""),
  address: String(x?.address ?? ""),
});
export class GraphMail implements MailReader {
  private graph: GraphReader;
  constructor(
    private accountId: string,
    token: () => Promise<string>,
    request: typeof fetch = fetch,
  ) {
    this.graph = new GraphReader(token, request);
  }
  private message(item: any): MailMessage {
    return {
      id: item.id,
      account_id: this.accountId,
      subject: item.subject || "(Utan ämne)",
      from: address(item.from?.emailAddress),
      to: (item.toRecipients ?? []).map((x: any) => address(x.emailAddress)),
      cc: (item.ccRecipients ?? []).map((x: any) => address(x.emailAddress)),
      received_at: item.receivedDateTime ?? item.sentDateTime ?? "",
      preview: String(item.bodyPreview ?? "").slice(0, 500),
      is_read: !!item.isRead,
      has_attachments: !!item.hasAttachments,
      conversation_id: item.conversationId ?? null,
      url: item.webLink ?? null,
    };
  }
  async search(input: MailSearch): Promise<MailPage> {
    const params = new URLSearchParams({
      $top: String(input.limit),
      $skip: String(input.offset),
      $select:
        "id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead,hasAttachments,conversationId,webLink",
    });
    if (input.query) params.set("$search", JSON.stringify(input.query));
    else params.set("$orderby", "receivedDateTime desc");
    const page = await this.graph.get(
      `me/mailFolders/${input.folder === "sent" ? "sentitems" : "inbox"}/messages?${params}`,
    );
    if (!Array.isArray(page.value))
      throw new HttpError(502, "Graph returnerade en ogiltig mejllista.");
    // Graph's actual skip may differ from the page size. Preserve the provider's offset.
    let next: number | null = null;
    if (page["@odata.nextLink"]) {
      const url = new URL(page["@odata.nextLink"]);
      if (
        url.origin !== "https://graph.microsoft.com" ||
        !url.pathname.startsWith("/v1.0/me/")
      )
        throw new HttpError(502, "Ogiltig Graph-sidadress.");
      const skip = Number(url.searchParams.get("$skip"));
      if (!Number.isSafeInteger(skip) || skip <= input.offset)
        throw new HttpError(502, "Graph returnerade en ogiltig sidmarkör.");
      next = skip <= 1000 ? skip : null;
    }
    return {
      messages: page.value.map((x: any) => this.message(x)),
      next_offset: next,
      fetched_at: new Date().toISOString(),
    };
  }
  async get(id: string): Promise<MailDetail> {
    const item = await this.graph.get(
      `me/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead,hasAttachments,conversationId,webLink,body`,
    );
    const body = String(item.body?.content ?? "");
    return {
      ...this.message(item),
      body: body.slice(0, 30000),
      body_truncated: body.length > 30000,
    };
  }
}
export class EwsMail extends EwsClient implements MailReader {
  private mailItems(items: any): any[] {
    return [
      "Message",
      "MeetingRequest",
      "MeetingResponse",
      "MeetingCancellation",
    ].flatMap((kind) => array(items?.[kind]));
  }
  private message(item: any): MailMessage {
    const mailbox = (x: any): MailAddress => ({
      name: text(x?.Name),
      address: text(x?.EmailAddress),
    });
    return {
      id: item.ItemId.Id,
      account_id: this.accountId,
      subject: text(item.Subject) || "(Utan ämne)",
      from: mailbox(item.From?.Mailbox ?? item.Sender?.Mailbox),
      to: array(item.ToRecipients?.Mailbox).map(mailbox),
      cc: array(item.CcRecipients?.Mailbox).map(mailbox),
      received_at: text(item.DateTimeReceived ?? item.DateTimeSent),
      preview: text(item.Preview).slice(0, 500),
      is_read: item.IsRead === "true",
      has_attachments: item.HasAttachments === "true",
      conversation_id: item.ConversationId?.Id ?? null,
      url: null,
    };
  }
  async search(input: MailSearch): Promise<MailPage> {
    const fields = [
      "item:Subject",
      "item:DateTimeReceived",
      "item:DateTimeSent",
      "item:HasAttachments",
      "item:ConversationId",
      "message:From",
      "message:Sender",
      "message:IsRead",
    ];
    const [page] = await this.call(
      "FindItem",
      `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${fields.map((x) => `<t:FieldURI FieldURI="${x}"/>`).join("")}</t:AdditionalProperties></m:ItemShape><m:IndexedPageItemView MaxEntriesReturned="${input.limit}" Offset="${input.offset}" BasePoint="Beginning"/><m:SortOrder><t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder></m:SortOrder><m:ParentFolderIds><t:DistinguishedFolderId Id="${input.folder === "sent" ? "sentitems" : "inbox"}"/></m:ParentFolderIds>${input.query ? `<m:QueryString>${escapeXml(input.query)}</m:QueryString>` : ""}`,
      'Traversal="Shallow"',
    );
    if (!page.RootFolder) throw new HttpError(502, "EWS saknar mejlresultat.");
    const messages = this.mailItems(page.RootFolder.Items)
      .map((x) => this.message(x))
      .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
    const next = Number(
      page.RootFolder.IndexedPagingOffset ?? input.offset + messages.length,
    );
    return {
      messages,
      next_offset:
        page.RootFolder.IncludesLastItemInRange === "false" &&
        next > input.offset &&
        next <= 1000
          ? next
          : null,
      fetched_at: new Date().toISOString(),
    };
  }
  async get(id: string): Promise<MailDetail> {
    const [page] = await this.call(
      "GetItem",
      `<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape><t:BodyType>Text</t:BodyType></m:ItemShape><m:ItemIds><t:ItemId Id="${escapeXml(id)}"/></m:ItemIds>`,
    );
    const item = this.mailItems(page.Items)[0];
    if (!item) throw new HttpError(502, "EWS hittade inte mejlet.");
    const body = text(item.Body);
    return {
      ...this.message(item),
      body: body.slice(0, 30000),
      body_truncated: body.length > 30000,
    };
  }
}
