import { PAGE_SIZE_SCAN } from "./constants.js";
import {
  ADDRESS_MAX,
  bodyToText,
  NAME_MAX,
  RECIPIENTS_MAX,
  sanitizeLine,
  SUBJECT_MAX,
  summarizeMessage,
  truncate,
  type MessageSummary,
} from "./format.js";
import { GraphClient, odataString } from "./graph.js";
import type { BatchRequest, GraphHeader, GraphMailFolder, GraphMessage, UnsubscribeInfo } from "./types.js";
import {
  buildMailtoUrl,
  checkUnsubscribeLink,
  checkUnsubscribeLinkWithoutLookup,
  oneClickPost,
  parseListUnsubscribe,
  type Refusal,
  type UnsubscribeNetwork,
} from "./unsubscribe.js";

const WELL_KNOWN = new Set(["inbox", "drafts", "sentitems", "deleteditems", "junkemail", "archive", "outbox"]);
const LIST_SELECT = "id,subject,from,receivedDateTime,isRead,bodyPreview";
const SCAN_SELECT = "id,subject,from,receivedDateTime,isRead";

export interface FolderInfo {
  id: string;
  name: string;
  path: string;
  parentId?: string;
  total: number;
  unread: number;
  wellKnownName?: string;
}

export interface SearchParams {
  folder?: string;
  from?: string;
  since?: string;
  until?: string;
  unreadOnly?: boolean;
  query?: string;
  limit: number;
  cursor?: string;
}

export interface SenderStats {
  address: string;
  name: string;
  domain: string;
  count: number;
  unreadCount: number;
  lastReceived: string;
  lastSubject: string;
  lastMessageId: string;
  unsubscribe?: UnsubscribeInfo;
}

export interface ActionOutcome {
  id: string;
  ok: boolean;
  /** New id of the message after a move (Outlook ids change when the folder changes). */
  newId?: string;
  error?: string;
}

/** The most messages mail_bulk_by_sender acts on in one call. */
export const BULK_LIMIT = 5000;

export interface BulkResult {
  /** Messages acted on, or that would be with a dry run: at most BULK_LIMIT. */
  matched: number;
  /** True when the sender has more than BULK_LIMIT messages in the folder: only BULK_LIMIT were counted and acted on. */
  capped: boolean;
  dryRun: boolean;
  /** One per message acted on; empty for a dry run. */
  outcomes: ActionOutcome[];
}

export type UnsubscribeMethod = "one-click" | "mailto" | "browser" | "blocked" | "none";

const LOCAL_LINK =
  "This unsubscribe link points to this computer or the local network, which a real newsletter never does. It was not opened. Treat this message as suspicious.";
const HTTP_LINK = "This unsubscribe link is not encrypted (http) and was not opened.";
const MAILTO_HOWTO = "Mail-MCP never sends email: give the user this link. It opens a pre-filled message in their own mail app, and they press Send.";

function blockedDetail(refusal: Refusal): string {
  return refusal.reason === "non-public" ? LOCAL_LINK : `This unsubscribe link could not be checked (${refusal.why}), so it was not opened.`;
}

/** The unsubscribe options of a message as mail_get_message and mail_senders_summary show them. */
export interface UnsubscribeOptions {
  /** The method mail_unsubscribe would use. */
  method: UnsubscribeMethod;
  oneClick: boolean;
  /** The https link, only when it may be opened. */
  https?: string;
  mailto?: string;
  mailtoSubject?: string;
  mailtoBody?: string;
  /** Why the link is blocked, or not used. */
  detail?: string;
}

/**
 * `info` labelled with the method `MailService.unsubscribe` would use, following the same cascade
 * without the network, and without anything that cascade would not hand over: a link it would block
 * (a non-public IP address, `localhost`, a name under `.localhost`, not a valid URL) leaves out the
 * link and the mailto address, and a plain http link is never shown. A host name is only looked up
 * when mail_unsubscribe runs, so a `one-click` or `browser` label can still end up `blocked` then.
 */
export function unsubscribeOptions(info: UnsubscribeInfo): UnsubscribeOptions {
  const mailto = info.mailto
    ? {
        mailto: info.mailto,
        ...(info.mailtoSubject ? { mailtoSubject: info.mailtoSubject } : {}),
        ...(info.mailtoBody ? { mailtoBody: info.mailtoBody } : {}),
      }
    : undefined;
  if (info.https) {
    const refusal = checkUnsubscribeLinkWithoutLookup(info.https);
    if (refusal) return { method: "blocked", oneClick: false, detail: blockedDetail(refusal) };
    if (!/^https:\/\//i.test(info.https)) {
      return mailto
        ? { method: "mailto", oneClick: false, ...mailto, detail: `${HTTP_LINK} The sender also accepts unsubscribe requests by email.` }
        : { method: "blocked", oneClick: false, detail: HTTP_LINK };
    }
    return { method: info.oneClick ? "one-click" : "browser", oneClick: info.oneClick, https: info.https, ...mailto };
  }
  return mailto ? { method: "mailto", oneClick: false, ...mailto } : { method: "none", oneClick: false };
}

export interface UnsubscribeOutcome {
  method: UnsubscribeMethod;
  ok: boolean;
  url?: string;
  mailto?: string;
  /** A `mailto:` link for the user to open in their own mail app. The server never sends the email. */
  mailtoUrl?: string;
  detail: string;
  from: string;
  subject: string;
}

function isWellKnown(s: string): boolean {
  return WELL_KNOWN.has(s.toLowerCase());
}

/** Heuristic: Graph ids are long base64-ish strings; folder names are not. */
function looksLikeId(s: string): boolean {
  return s.length > 60 && /^[A-Za-z0-9_=\-]+$/.test(s);
}

export class MailService {
  private folderCache?: FolderInfo[];
  private readonly summaryCache = new Map<string, SenderStats[]>();

  constructor(
    private readonly graph: GraphClient,
    /** DNS resolver and HTTPS client for unsubscribe links; the real ones by default. */
    private readonly unsubscribeNetwork: UnsubscribeNetwork = {},
  ) {}

  // ---------- Folders ----------

  async listFolders(force = false): Promise<FolderInfo[]> {
    if (this.folderCache && !force) return this.folderCache;
    const out: FolderInfo[] = [];
    const walk = async (path: string, parentPath: string): Promise<void> => {
      for await (const f of this.graph.paginate<GraphMailFolder>(`${path}?$top=250`)) {
        // Folder names are shown, and matched against the names the assistant passes back, cleaned.
        const name = sanitizeLine(f.displayName ?? "");
        const fullPath = parentPath ? `${parentPath}/${name}` : name;
        out.push({
          id: f.id,
          name,
          path: fullPath,
          ...(f.parentFolderId ? { parentId: f.parentFolderId } : {}),
          total: f.totalItemCount ?? 0,
          unread: f.unreadItemCount ?? 0,
          ...(f.wellKnownName ? { wellKnownName: f.wellKnownName } : {}),
        });
        if ((f.childFolderCount ?? 0) > 0) await walk(`/me/mailFolders/${f.id}/childFolders`, fullPath);
      }
    };
    await walk("/me/mailFolders", "");
    this.folderCache = out;
    return out;
  }

  /** Resolve a folder given a well-known name, display name, path, or id. Returns the Graph path segment. */
  async resolveFolderId(nameOrId: string | undefined): Promise<string> {
    if (!nameOrId) return "inbox";
    if (isWellKnown(nameOrId)) return nameOrId.toLowerCase();
    if (looksLikeId(nameOrId)) return nameOrId;
    const folders = await this.listFolders();
    const lower = nameOrId.toLowerCase();
    const match =
      folders.find((f) => f.path.toLowerCase() === lower) ??
      folders.find((f) => f.name.toLowerCase() === lower) ??
      folders.find((f) => f.wellKnownName?.toLowerCase() === lower);
    if (!match) {
      throw new Error(
        `Folder "${nameOrId}" not found. Available folders: ${folders.map((f) => f.path).join(", ")}. Use mail_create_folder to create it.`,
      );
    }
    return match.id;
  }

  async createFolder(name: string, parent?: string): Promise<{ folder: FolderInfo; created: boolean }> {
    const folders = await this.listFolders();
    const parentId = parent ? await this.resolveFolderId(parent) : undefined;
    const existing = folders.find(
      (f) => f.name.toLowerCase() === name.toLowerCase() && (!parentId || f.parentId === parentId || parent?.toLowerCase() === f.path.split("/").slice(0, -1).join("/").toLowerCase()),
    );
    if (existing) return { folder: existing, created: false };
    const path = parentId ? `/me/mailFolders/${parentId}/childFolders` : "/me/mailFolders";
    const created = await this.graph.post<GraphMailFolder>(path, { displayName: name, isHidden: false });
    await this.listFolders(true);
    const folder = (await this.listFolders()).find((f) => f.id === created.id) ?? {
      id: created.id,
      name: sanitizeLine(created.displayName ?? ""),
      path: sanitizeLine(created.displayName ?? ""),
      total: 0,
      unread: 0,
    };
    return { folder, created: true };
  }

  // ---------- Messages ----------

  async search(p: SearchParams): Promise<{ items: MessageSummary[]; nextCursor?: string }> {
    let path: string;
    if (p.cursor) {
      path = p.cursor;
    } else {
      const folderId = await this.resolveFolderId(p.folder);
      const qs: string[] = [`$select=${LIST_SELECT}`, `$top=${p.limit}`];
      if (p.query) {
        qs.push(`$search=${encodeURIComponent(`"${p.query.replace(/"/g, '\\"')}"`)}`);
      } else {
        const filters: string[] = [];
        // receivedDateTime must lead the filter when we also order by it.
        filters.push(`receivedDateTime ge ${p.since ?? "1970-01-01T00:00:00Z"}`);
        if (p.until) filters.push(`receivedDateTime le ${p.until}`);
        if (p.from) filters.push(`from/emailAddress/address eq ${odataString(p.from.toLowerCase())}`);
        if (p.unreadOnly) filters.push("isRead eq false");
        qs.push(`$filter=${encodeURIComponent(filters.join(" and "))}`);
        qs.push(`$orderby=${encodeURIComponent("receivedDateTime desc")}`);
      }
      path = `/me/mailFolders/${folderId}/messages?${qs.join("&")}`;
    }
    const page = await this.graph.page<GraphMessage>(path);
    return { items: page.items.map(summarizeMessage), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async getMessage(id: string): Promise<{
    summary: MessageSummary;
    /** The first RECIPIENTS_MAX recipient addresses. */
    to: string[];
    /** How many recipient addresses the message has. */
    toTotal: number;
    body: string;
    truncated: boolean;
    hasAttachments: boolean;
    webLink?: string;
    unsubscribe: UnsubscribeInfo;
  }> {
    const m = await this.graph.get<GraphMessage>(
      `/me/messages/${encodeURIComponent(id)}?$select=${LIST_SELECT},toRecipients,hasAttachments,body,internetMessageHeaders,webLink`,
      );
    const { text, truncated } = truncate(bodyToText(m.body));
    const to = (m.toRecipients ?? []).map((r) => sanitizeLine(r.emailAddress?.address ?? "", ADDRESS_MAX)).filter(Boolean);
    return {
      summary: summarizeMessage(m),
      to: to.slice(0, RECIPIENTS_MAX),
      toTotal: to.length,
      body: text,
      truncated,
      hasAttachments: m.hasAttachments ?? false,
      ...(m.webLink ? { webLink: m.webLink } : {}),
      unsubscribe: parseListUnsubscribe(m.internetMessageHeaders),
    };
  }

  private async headersFor(ids: string[]): Promise<Map<string, GraphHeader[]>> {
    const reqs: BatchRequest[] = ids.map((id) => ({
      id,
      method: "GET",
      url: `/me/messages/${encodeURIComponent(id)}?$select=id,internetMessageHeaders`,
    }));
    const out = new Map<string, GraphHeader[]>();
    for (const r of await this.graph.batch(reqs)) {
      if (r.status >= 200 && r.status < 300) {
        const body = r.body as GraphMessage | undefined;
        out.set(r.id, body?.internetMessageHeaders ?? []);
      }
    }
    return out;
  }

  async sendersSummary(folder: string | undefined, since: string | undefined, top: number): Promise<{ senders: SenderStats[]; scanned: number; totalSenders: number }> {
    const folderId = await this.resolveFolderId(folder);
    const key = `${folderId}|${since ?? ""}`;
    let all = this.summaryCache.get(key);
    let scanned = 0;
    if (!all) {
      const byAddress = new Map<string, SenderStats>();
      const qs = [`$select=${SCAN_SELECT}`, `$top=${PAGE_SIZE_SCAN}`];
      if (since) qs.push(`$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`);
      for await (const m of this.graph.paginate<GraphMessage>(`/me/mailFolders/${folderId}/messages?${qs.join("&")}`)) {
        scanned++;
        const address = sanitizeLine(m.from?.emailAddress?.address?.toLowerCase() ?? "", ADDRESS_MAX);
        if (!address) continue;
        const name = m.from?.emailAddress?.name;
        const received = m.receivedDateTime ?? "";
        const cur = byAddress.get(address);
        if (cur) {
          cur.count++;
          if (!m.isRead) cur.unreadCount++;
          if (received > cur.lastReceived) {
            cur.lastReceived = received;
            cur.lastSubject = sanitizeLine(m.subject ?? "", SUBJECT_MAX);
            cur.lastMessageId = m.id;
            if (name != null) cur.name = sanitizeLine(name, NAME_MAX);
          }
        } else {
          byAddress.set(address, {
            address,
            name: sanitizeLine(name ?? "", NAME_MAX),
            domain: address.split("@")[1] ?? "",
            count: 1,
            unreadCount: m.isRead ? 0 : 1,
            lastReceived: received,
            lastSubject: sanitizeLine(m.subject ?? "", SUBJECT_MAX),
            lastMessageId: m.id,
          });
        }
      }
      all = [...byAddress.values()].sort((a, b) => b.count - a.count || (a.lastReceived < b.lastReceived ? 1 : -1));
      this.summaryCache.set(key, all);
    } else {
      scanned = all.reduce((n, s) => n + s.count, 0);
    }

    const selected = all.slice(0, top);
    const missing = selected.filter((s) => !s.unsubscribe);
    if (missing.length > 0) {
      const headers = await this.headersFor(missing.map((s) => s.lastMessageId));
      for (const s of missing) s.unsubscribe = parseListUnsubscribe(headers.get(s.lastMessageId));
    }
    return { senders: selected, scanned, totalSenders: all.length };
  }

  // ---------- Actions ----------

  private async runBatch(reqs: BatchRequest[]): Promise<ActionOutcome[]> {
    if (reqs.length === 0) return [];
    const responses = await this.graph.batch(reqs);
    return responses.map((r) => {
      const ok = r.status >= 200 && r.status < 300;
      if (ok) {
        const newId = (r.body as GraphMessage | undefined)?.id;
        return newId && newId !== r.id ? { id: r.id, ok, newId } : { id: r.id, ok };
      }
      const body = r.body as { error?: { code?: string; message?: string } } | undefined;
      const detail = body?.error?.code ?? body?.error?.message ?? `HTTP ${r.status}`;
      return { id: r.id, ok, error: detail };
    });
  }

  async move(ids: string[], folder: string): Promise<ActionOutcome[]> {
    const destinationId = await this.resolveFolderId(folder);
    return this.runBatch(
      ids.map((id) => ({ id, method: "POST", url: `/me/messages/${encodeURIComponent(id)}/move`, body: { destinationId }, headers: { "Content-Type": "application/json" } })),
    );
  }

  /**
   * Soft delete: move to the Deleted Items folder (visible in Outlook, restorable). Never deletes permanently.
   * Graph's DELETE would instead put the item in Recoverable Items, invisible to the user, so it is not used.
   */
  async delete(ids: string[]): Promise<ActionOutcome[]> {
    return this.move(ids, "deleteditems");
  }

  /** Permanent deletion (Graph permanentDelete): irreversible. Only the mail_purge tool calls it. */
  async permanentDelete(ids: string[]): Promise<ActionOutcome[]> {
    return this.runBatch(ids.map((id) => ({ id, method: "POST" as const, url: `/me/messages/${encodeURIComponent(id)}/permanentDelete` })));
  }

  /**
   * Collect the ids of the messages from a sender in a folder, at most `maxItems`. `capped` is true
   * when the sender has more messages there than that.
   */
  async idsFromSender(from: string, folder: string | undefined, maxItems = BULK_LIMIT): Promise<{ ids: string[]; capped: boolean }> {
    const folderId = await this.resolveFolderId(folder);
    const filter = encodeURIComponent(`from/emailAddress/address eq ${odataString(from.toLowerCase())}`);
    const ids: string[] = [];
    // One more than the limit tells whether the sender has more messages than one call handles.
    for await (const m of this.graph.paginate<GraphMessage>(`/me/mailFolders/${folderId}/messages?$select=id&$top=${PAGE_SIZE_SCAN}&$filter=${filter}`, maxItems + 1)) {
      ids.push(m.id);
    }
    const capped = ids.length > maxItems;
    return { ids: capped ? ids.slice(0, maxItems) : ids, capped };
  }

  /**
   * Move every message from a sender in a folder to `targetFolder` (action "move") or to Deleted Items
   * (action "delete"), at most BULK_LIMIT per call. Never deletes permanently. A dry run unless
   * `dryRun` is exactly `false`: it then only counts the messages it would act on, after checking
   * that `targetFolder` exists.
   */
  async bulkBySender(p: { from: string; folder?: string; action: "move" | "delete"; targetFolder?: string; dryRun?: boolean }): Promise<BulkResult> {
    const dryRun = p.dryRun !== false; // only an explicit false acts
    if (p.action === "move") {
      if (!p.targetFolder) throw new Error("`targetFolder` is required when action = move.");
      await this.resolveFolderId(p.targetFolder);
    }
    const { ids, capped } = await this.idsFromSender(p.from, p.folder);
    if (dryRun || ids.length === 0) return { matched: ids.length, capped, dryRun, outcomes: [] };
    const outcomes = p.action === "move" ? await this.move(ids, p.targetFolder!) : await this.delete(ids);
    return { matched: ids.length, capped, dryRun: false, outcomes };
  }

  invalidateSummaries(): void {
    this.summaryCache.clear();
  }

  async unsubscribe(id: string): Promise<UnsubscribeOutcome> {
    const m = await this.graph.get<GraphMessage>(`/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,internetMessageHeaders`);
    const info = parseListUnsubscribe(m.internetMessageHeaders);
    const base = { from: sanitizeLine(m.from?.emailAddress?.address ?? "", ADDRESS_MAX), subject: sanitizeLine(m.subject ?? "", SUBJECT_MAX) };

    // A link is only ever POSTed to or handed to the browser once its host is known to be public.
    // A link to a non-public host, or one that cannot be checked, blocks everything, the mailto link
    // included, whatever its scheme: the message is not to be trusted. A plain http link to a
    // public host is simply not used.
    const httpOnly = !!info.https && !/^https:\/\//i.test(info.https);
    const link = httpOnly ? undefined : info.https;
    let oneClickFailure: string | undefined;
    if (info.https) {
      let refusal: Refusal | undefined;
      if (info.oneClick && link) {
        const r = await oneClickPost(link, this.unsubscribeNetwork);
        if (r.ok) return { ...base, method: "one-click", ok: true, url: link, detail: r.detail };
        refusal = r.refusal;
        oneClickFailure = r.detail;
      } else {
        refusal = await checkUnsubscribeLink(info.https, this.unsubscribeNetwork.resolveHost);
      }
      if (refusal) return { ...base, method: "blocked", ok: false, detail: blockedDetail(refusal) };
    }
    // Built only once one-click is out of the picture: nothing about the mailto link can stand in its way.
    const mailtoUrl = buildMailtoUrl(info);
    const mailtoFields = info.mailto && mailtoUrl ? { mailto: info.mailto, mailtoUrl } : {};
    if (link) {
      return {
        ...base,
        method: "browser",
        ok: false,
        url: link,
        ...mailtoFields,
        detail: oneClickFailure ?? "No one-click support: open this URL in a browser and confirm the unsubscribe.",
      };
    }
    if (info.mailto && mailtoUrl) {
      return {
        ...base,
        method: "mailto",
        ok: false,
        ...mailtoFields,
        detail: httpOnly
          ? `${HTTP_LINK} The sender also accepts unsubscribe requests by email. ${MAILTO_HOWTO}`
          : `This sender only accepts unsubscribe requests by email. ${MAILTO_HOWTO}`,
      };
    }
    if (httpOnly) return { ...base, method: "blocked", ok: false, detail: HTTP_LINK };
    return {
      ...base,
      method: "none",
      ok: false,
      detail: "No List-Unsubscribe header. Look for an unsubscribe link in the body via mail_get_message, or remove the sender in bulk with mail_bulk_by_sender.",
    };
  }
}
