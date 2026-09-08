import type { GraphHeader, UnsubscribeInfo } from "./types.js";

const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

function header(headers: GraphHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** Extract every <...> entry from a List-Unsubscribe header value. */
export function splitListUnsubscribe(value: string): string[] {
  const out: string[] = [];
  const re = /<([^>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const entry = m[1]?.replace(/\s+/g, "").trim();
    if (entry) out.push(entry);
  }
  return out;
}

function parseMailto(uri: string): { address: string; subject?: string; body?: string } | undefined {
  if (!/^mailto:/i.test(uri)) return undefined;
  const rest = uri.slice("mailto:".length);
  const [addrPart, query = ""] = rest.split("?", 2);
  const address = decodeURIComponent(addrPart ?? "").trim();
  if (!address) return undefined;
  const params = new URLSearchParams(query);
  const subject = params.get("subject") ?? undefined;
  const body = params.get("body") ?? undefined;
  return { address, ...(subject ? { subject } : {}), ...(body ? { body } : {}) };
}

/** Parse List-Unsubscribe / List-Unsubscribe-Post headers into structured info. */
export function parseListUnsubscribe(headers: GraphHeader[] | undefined): UnsubscribeInfo {
  const lu = header(headers, "List-Unsubscribe");
  const post = header(headers, "List-Unsubscribe-Post");
  const info: UnsubscribeInfo = { oneClick: false };
  if (!lu) return info;

  for (const entry of splitListUnsubscribe(lu)) {
    if (/^https:\/\//i.test(entry) && !info.https) {
      info.https = entry;
    } else if (/^http:\/\//i.test(entry) && !info.https) {
      // Plain http links are accepted for the browser fallback only.
      info.https = entry;
    } else if (/^mailto:/i.test(entry) && !info.mailto) {
      const m = parseMailto(entry);
      if (m) {
        info.mailto = m.address;
        if (m.subject) info.mailtoSubject = m.subject;
        if (m.body) info.mailtoBody = m.body;
      }
    }
  }

  const postOk = !!post && post.replace(/\s+/g, "").toLowerCase() === ONE_CLICK_BODY.toLowerCase();
  info.oneClick = postOk && !!info.https && /^https:\/\//i.test(info.https);
  return info;
}

export interface OneClickResult {
  ok: boolean;
  status?: number;
  detail: string;
}

/**
 * Perform an RFC 8058 one-click unsubscribe POST.
 * No cookies, no auth, no redirects followed. Success = any 2xx.
 */
export async function oneClickPost(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<OneClickResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "mail-mcp/0.1" },
      body: ONE_CLICK_BODY,
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, detail: `POST one-click accepté (HTTP ${res.status}).` };
    }
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, detail: `Le serveur a répondu par une redirection (HTTP ${res.status}), non conforme RFC 8058. Ouvrez l'URL dans un navigateur.` };
    }
    return { ok: false, status: res.status, detail: `POST one-click refusé (HTTP ${res.status}). Ouvrez l'URL dans un navigateur.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `POST one-click impossible (${msg}). Ouvrez l'URL dans un navigateur.` };
  } finally {
    clearTimeout(timer);
  }
}
