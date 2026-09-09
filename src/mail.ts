import { PAGE_SIZE_SCAN } from "./constants.js";
import { bodyToText, summarizeMessage, truncate, type MessageSummary } from "./format.js";
import { GraphClient, odataString } from "./graph.js";
import type { BatchRequest, GraphHeader, GraphMailFolder, GraphMessage, UnsubscribeInfo } from "./types.js";
import { oneClickPost, parseListUnsubscribe } from "./unsubscribe.js";

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

export type UnsubscribeMethod = "one-click" | "mailto" | "browser" | "none";

export interface UnsubscribeOutcome {
  method: UnsubscribeMethod;
  ok: boolean;
  url?: string;
  mailto?: string;
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
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  // ---------- Folders ----------

  async listFolders(force = false): Promise<FolderInfo[]> {
    if (this.folderCache && !force) return this.folderCache;
    const out: FolderInfo[] = [];
    const walk = async (path: string, parentPath: string): Promise<void> => {
      for await (const f of this.graph.paginate<GraphMailFolder>(`${path}?$top=250`)) {
        const fullPath = parentPath ? `${parentPath}/${f.displayName}` : f.displayName;
        out.push({
          id: f.id,
          name: f.displayName,
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
      name: created.displayName,
      path: created.displayName,
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
    to: string[];
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
    return {
      summary: summarizeMessage(m),
      to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
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
        const address = m.from?.emailAddress?.address?.toLowerCase();
        if (!address) continue;
        const received = m.receivedDateTime ?? "";
        const cur = byAddress.get(address);
        if (cur) {
          cur.count++;
          if (!m.isRead) cur.unreadCount++;
          if (received > cur.lastReceived) {
            cur.lastReceived = received;
            cur.lastSubject = m.subject ?? "";
            cur.lastMessageId = m.id;
            cur.name = m.from?.emailAddress?.name ?? cur.name;
          }
        } else {
          byAddress.set(address, {
            address,
            name: m.from?.emailAddress?.name ?? "",
            domain: address.split("@")[1] ?? "",
            count: 1,
            unreadCount: m.isRead ? 0 : 1,
            lastReceived: received,
            lastSubject: m.subject ?? "",
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
   * Soft delete = move to the Deleted Items folder (visible in Outlook, restorable).
   * Graph's DELETE would instead put the item in Recoverable Items, invisible to the user, so it is not used.
   * Permanent = permanentDelete (irreversible).
   */
  async delete(ids: string[], permanent: boolean): Promise<ActionOutcome[]> {
    if (!permanent) return this.move(ids, "deleteditems");
    return this.runBatch(ids.map((id) => ({ id, method: "POST" as const, url: `/me/messages/${encodeURIComponent(id)}/permanentDelete` })));
  }

  /** Collect every message id from a sender in a folder. */
  async idsFromSender(from: string, folder: string | undefined, maxItems = 5000): Promise<string[]> {
    const folderId = await this.resolveFolderId(folder);
    const filter = encodeURIComponent(`from/emailAddress/address eq ${odataString(from.toLowerCase())}`);
    const ids: string[] = [];
    for await (const m of this.graph.paginate<GraphMessage>(`/me/mailFolders/${folderId}/messages?$select=id&$top=${PAGE_SIZE_SCAN}&$filter=${filter}`, maxItems)) {
      ids.push(m.id);
    }
    return ids;
  }

  invalidateSummaries(): void {
    this.summaryCache.clear();
  }

  async unsubscribe(id: string): Promise<UnsubscribeOutcome> {
    const m = await this.graph.get<GraphMessage>(`/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,internetMessageHeaders`);
    const info = parseListUnsubscribe(m.internetMessageHeaders);
    const base = { from: m.from?.emailAddress?.address ?? "", subject: m.subject ?? "" };

    if (info.oneClick && info.https) {
      const r = await oneClickPost(info.https, this.fetchImpl);
      if (r.ok) return { ...base, method: "one-click", ok: true, url: info.https, detail: r.detail };
      if (info.mailto) {
        const viaMail = await this.unsubscribeByMail(info);
        return { ...base, ...viaMail, detail: `${r.detail} Email fallback: ${viaMail.detail}` };
      }
      return { ...base, method: "browser", ok: false, url: info.https, detail: `${r.detail}` };
    }
    if (info.mailto) {
      return { ...base, ...(await this.unsubscribeByMail(info)) };
    }
    if (info.https) {
      return { ...base, method: "browser", ok: false, url: info.https, detail: "No one-click support: open this URL in a browser and confirm the unsubscribe." };
    }
    return {
      ...base,
      method: "none",
      ok: false,
      detail: "No List-Unsubscribe header. Look for an unsubscribe link in the body via mail_get_message, or remove the sender in bulk with mail_bulk_by_sender.",
    };
  }

  private async unsubscribeByMail(info: UnsubscribeInfo): Promise<Omit<UnsubscribeOutcome, "from" | "subject">> {
    const address = info.mailto!;
    const subject = info.mailtoSubject ?? "unsubscribe";
    const content = info.mailtoBody ?? "unsubscribe";
    try {
      await this.graph.post("/me/sendMail", {
        message: { subject, body: { contentType: "text", content }, toRecipients: [{ emailAddress: { address } }] },
        saveToSentItems: false,
      });
      return { method: "mailto", ok: true, mailto: address, detail: `Unsubscribe email sent to ${address} (subject "${subject}").` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { method: "mailto", ok: false, mailto: address, detail: `Sending to ${address} failed: ${msg}` };
    }
  }
}
