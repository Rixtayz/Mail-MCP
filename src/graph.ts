import { BATCH_SIZE, GRAPH_BASE, MAX_RETRIES } from "./constants.js";
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

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Map Graph HTTP errors to actionable messages for the model. */
export function describeGraphError(status: number, code: string | undefined, raw: string): string {
  switch (status) {
    case 401:
      return "Unauthorized (401): the token is expired or invalid. Run `npm run login` again in the Mail-MCP folder.";
    case 403:
      return `Forbidden (403${code ? ", " + code : ""}): the app registration probably lacks the Mail.ReadWrite / Mail.Send permissions. Check the README, then run \`npm run login\` again.`;
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
  private readonly baseUrl: string;

  constructor(opts: GraphClientOptions) {
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.baseUrl = opts.baseUrl ?? GRAPH_BASE;
  }

  /** Absolute URL for a Graph path (or pass-through for a full nextLink URL). */
  private url(pathOrUrl: string): string {
    return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  }

  /** Perform a request with bearer auth and retry on 429/503/504. Returns parsed JSON (or undefined for 204). */
  async request<T = unknown>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    pathOrUrl: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      const token = await this.getToken();
      const res = await this.fetchImpl(this.url(pathOrUrl), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_RETRIES) {
        attempt++;
        const retryAfter = Number(res.headers.get("Retry-After"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 500, 10_000);
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
   * Execute requests through /$batch in serialized chunks of 20.
   * Returns one response per request id, in input order. Retries throttled sub-requests.
   */
  async batch(requests: BatchRequest[]): Promise<BatchResponse[]> {
    const results = new Map<string, BatchResponse>();
    let pending = requests.map((r) => ({ ...r, url: r.url.startsWith("/") ? r.url : `/${r.url}` }));
    let attempt = 0;

    while (pending.length > 0) {
      const retry: BatchRequest[] = [];
      for (const chunk of chunkArray(pending, BATCH_SIZE)) {
        const res = await this.post<{ responses: BatchResponse[] }>("/$batch", { requests: chunk });
        for (const r of res.responses) {
          if ((r.status === 429 || r.status === 503) && attempt < MAX_RETRIES) {
            const original = chunk.find((c) => c.id === r.id);
            if (original) retry.push(original);
          } else {
            results.set(r.id, r);
          }
        }
      }
      if (retry.length === 0) break;
      attempt++;
      await this.sleep(Math.min(2 ** attempt * 1000, 15_000));
      pending = retry;
    }
    // Anything still pending after retries is reported as 429.
    for (const p of pending) if (!results.has(p.id)) results.set(p.id, { id: p.id, status: 429 });
    return requests.map((r) => results.get(r.id) ?? { id: r.id, status: 0 });
  }
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Escape a string literal for use inside an OData $filter. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
