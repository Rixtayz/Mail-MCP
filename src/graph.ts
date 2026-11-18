import { BATCH_SIZE, GRAPH_BASE, MAX_RETRIES, MAX_RETRY_AFTER_MS } from "./constants.js";
import type { BatchRequest, BatchResponse, GraphPage } from "./types.js";

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export interface GraphClientOptions {
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

// Never echoes the rejected URL: it is attacker-chosen text that would land in the assistant's context.
const OUTSIDE_GRAPH = "Refused to call a URL outside Microsoft Graph. Pass back the cursor exactly as mail_search returned it.";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// mail_login answers "Signed in" as long as a token can be had silently, so after a 401 or 403 a new
// mail_login can leave the same token in place and the retry fail again. Signing out first breaks that loop.
const IF_IT_PERSISTS = "If this keeps happening, call mail_logout, then mail_login.";

/** "(401, Code): Microsoft's message." or "(401)." when Microsoft gave no message. */
function said(status: number, code: string | undefined, raw: string): string {
  const message = raw.slice(0, 300).trim();
  const head = `(${status}${code ? ", " + code : ""})`;
  if (!message) return `${head}.`;
  return `${head}: ${message}${/[.!?]$/.test(message) ? "" : "."}`;
}

/** Map Graph HTTP errors to actionable messages for the model. */
export function describeGraphError(status: number, code: string | undefined, raw: string): string {
  switch (status) {
    case 401:
      return `Microsoft rejected the sign-in ${said(status, code, raw)} Call the mail_login tool to sign the user in again. ${IF_IT_PERSISTS}`;
    case 403:
      return `Microsoft refused the request ${said(status, code, raw)} ${IF_IT_PERSISTS}`;
    case 404:
      return "Not found (404): the message or folder no longer exists (moved or deleted; ids change when a message changes folder). Call mail_search or mail_list_folders again to get fresh ids.";
    case 429:
      return "Microsoft rate limit hit (429) despite retries. Wait a minute, then retry with fewer items.";
    default:
      return `Graph error ${status}${code ? " (" + code + ")" : ""}: ${raw.slice(0, 300)}`;
  }
}

export class GraphClient {
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: URL;
  private readonly basePath: string;

  constructor(opts: GraphClientOptions) {
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.base = new URL(opts.baseUrl ?? GRAPH_BASE);
    this.basePath = this.base.pathname.replace(/\/+$/, "");
  }

  /**
   * Absolute URL for a Graph path, or a full nextLink URL. The only choke point before the bearer token is
   * attached. Both forms are resolved to a parsed URL first, so `..`, `%2e%2e` and the like are already
   * collapsed, and only then checked to be under the base URL (parsed, not prefix-matched).
   */
  private url(pathOrUrl: string): string {
    const raw = /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : `${this.base.origin}${this.basePath}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      throw new GraphError(OUTSIDE_GRAPH, 0);
    }
    const inside =
      target.protocol === this.base.protocol &&
      target.hostname === this.base.hostname &&
      target.port === this.base.port &&
      target.username === "" &&
      target.password === "" &&
      (target.pathname === this.basePath || target.pathname.startsWith(`${this.basePath}/`));
    if (!inside) throw new GraphError(OUTSIDE_GRAPH, 0);
    return target.href;
  }

  /** Perform a request with bearer auth and retry on 429/503/504. Returns parsed JSON (or undefined for 204). */
  async request<T = unknown>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    pathOrUrl: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const url = this.url(pathOrUrl); // refuses a foreign URL before a token is even requested
    let attempt = 0;
    for (;;) {
      const token = await this.getToken();
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "error", // a redirect would carry the bearer token to wherever it points
      });

      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_RETRIES) {
        attempt++;
        const retryAfter = Number(res.headers.get("Retry-After"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : Math.min(2 ** attempt * 500, 10_000);
        await this.sleep(delay);
        continue;
      }

      if (res.status === 204 || res.status === 202) return undefined as T;

      const text = await res.text();
      if (!res.ok) {
        let code: string | undefined;
        let message = text;
        try {
          const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
          code = parsed.error?.code;
          message = parsed.error?.message ?? text;
        } catch {
          /* non-JSON error body */
        }
        throw new GraphError(describeGraphError(res.status, code, message), res.status, code);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T = undefined>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  delete(path: string): Promise<void> {
    return this.request<void>("DELETE", path);
  }

  /** Iterate every item of a paged collection, following @odata.nextLink. */
  async *paginate<T>(firstPath: string, maxItems = Number.POSITIVE_INFINITY): AsyncGenerator<T> {
    let next: string | undefined = firstPath;
    let count = 0;
    while (next && count < maxItems) {
      const page: GraphPage<T> = await this.get<GraphPage<T>>(next);
      for (const item of page.value) {
        yield item;
        if (++count >= maxItems) return;
      }
      next = page["@odata.nextLink"];
    }
  }

  /** Fetch one page and return items plus the opaque cursor for the next page. */
  async page<T>(pathOrCursor: string): Promise<{ items: T[]; nextCursor?: string }> {
    const page = await this.get<GraphPage<T>>(pathOrCursor);
    const nextCursor = page["@odata.nextLink"];
    return { items: page.value, ...(nextCursor ? { nextCursor } : {}) };
  }

  /**
   * Execute requests through /$batch in serialized chunks of 20. Retries throttled sub-requests.
   * Each request goes to Graph under its index ("0", "1", …), never under the caller's id: Graph fails the
   * whole batch (400) unless its ids are unique, compared without case, and a caller's id, such as a
   * case-sensitive message id, need not be.
   * Returns one response per request, in input order, under the caller's id.
   */
  async batch(requests: BatchRequest[]): Promise<BatchResponse[]> {
    const results = new Map<string, BatchResponse>();
    let pending = requests.map((r, i) => ({ ...r, id: String(i), url: r.url.startsWith("/") ? r.url : `/${r.url}` }));
    let attempt = 0;

    while (pending.length > 0) {
      const retry: BatchRequest[] = [];
      for (const chunk of chunkArray(pending, BATCH_SIZE)) {
        const res = await this.post<{ responses: BatchResponse[] }>("/$batch", { requests: chunk });
        for (const r of res.responses) {
          const original = chunk.find((c) => c.id === r.id);
          if (!original) continue; // answers no request of this chunk
          if ((r.status === 429 || r.status === 503) && attempt < MAX_RETRIES) retry.push(original);
          else results.set(r.id, r);
        }
      }
      if (retry.length === 0) break;
      attempt++;
      await this.sleep(Math.min(2 ** attempt * 1000, 15_000));
      pending = retry;
    }
    // Anything still pending after retries is reported as 429.
    for (const p of pending) if (!results.has(p.id)) results.set(p.id, { id: p.id, status: 429 });
    return requests.map((r, i) => ({ ...(results.get(String(i)) ?? { status: 0 }), id: r.id }));
  }
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const INVALID_ID =
  "Refused an id that is not one Microsoft Graph gave: pass ids exactly as mail_search, mail_senders_summary or mail_list_folders returned them.";

/**
 * A message or folder id as one segment of a Graph path. Encoded, so that a `/`, `?`, `#` or `%` in it stays
 * part of the segment. `.`, `..` and an empty id are refused: encoding leaves them as they are, and a URL
 * reads them as this level, the level above, or no segment, so the path would name another resource.
 */
export function pathSegment(id: string): string {
  if (id === "" || id === "." || id === "..") throw new GraphError(INVALID_ID, 0);
  return encodeURIComponent(id);
}

/** Escape a string literal for use inside an OData $filter. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
