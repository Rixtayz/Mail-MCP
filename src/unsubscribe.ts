import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
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

/** Every address a hostname resolves to, like `dns.lookup(host, { all: true })`. */
export type HostResolver = (hostname: string) => Promise<readonly { address: string }[]>;

const lookupAll: HostResolver = (hostname) => lookup(hostname, { all: true });

/**
 * Addresses an email must not make this machine POST to: this host, its local
 * network and other non-public ranges. BlockList also matches IPv4-mapped IPv6
 * addresses (::ffff:a.b.c.d) against the IPv4 rules.
 */
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network": 0.0.0.0 reaches localhost on Linux and macOS
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, also used by Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata endpoints
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3], // multicast, reserved and broadcast
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and deprecated IPv4-compatible
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv6");

function isNonPublic(address: string): boolean {
  const family = isIP(address);
  return family === 0 || NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

const OPEN_IN_BROWSER = "Open the URL in a browser instead.";

/**
 * Why the one-click POST must not be sent to `url`, or undefined when its host is public.
 * The URL comes from the email, so its sender must not be able to aim this machine at
 * localhost, the local network or a cloud metadata endpoint. A hostname is refused when
 * any of its addresses is non-public, since fetch may connect to any of them. This does
 * not pin the connection to the checked addresses: a DNS rebind between this lookup and
 * fetch's own lookup is not covered.
 */
async function refusal(url: string, resolveHost: HostResolver): Promise<string | undefined> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return `Refused the one-click POST: the URL is not valid. ${OPEN_IN_BROWSER}`;
  }
  const literal = hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(literal)) {
    return isNonPublic(literal)
      ? `Refused the one-click POST: ${literal} is a private, loopback or link-local address. ${OPEN_IN_BROWSER}`
      : undefined;
  }
  const name = hostname.replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) {
    return `Refused the one-click POST: ${name} points to this machine. ${OPEN_IN_BROWSER}`;
  }
  let addresses: readonly { address: string }[];
  try {
    addresses = await resolveHost(hostname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Refused the one-click POST: ${hostname} could not be resolved (${msg}). ${OPEN_IN_BROWSER}`;
  }
  if (addresses.length === 0) {
    return `Refused the one-click POST: ${hostname} has no address. ${OPEN_IN_BROWSER}`;
  }
  const blocked = addresses.find((a) => isNonPublic(a.address));
  if (blocked) {
    return `Refused the one-click POST: ${hostname} resolves to ${blocked.address}, a private, loopback or link-local address. ${OPEN_IN_BROWSER}`;
  }
  return undefined;
}

/**
 * Perform an RFC 8058 one-click unsubscribe POST.
 * No cookies, no auth, no redirects followed. Success = any 2xx.
 * Nothing is sent when the host is, or resolves to, a non-public address (see `refusal`).
 */
export async function oneClickPost(
  url: string,
  fetchImpl: typeof fetch = fetch,
  resolveHost: HostResolver = lookupAll,
  timeoutMs = 15_000,
): Promise<OneClickResult> {
  const refused = await refusal(url, resolveHost);
  if (refused) return { ok: false, detail: refused };

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
      return { ok: true, status: res.status, detail: `One-click POST accepted (HTTP ${res.status}).` };
    }
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, detail: `The server answered with a redirect (HTTP ${res.status}), which is not RFC 8058 compliant. Open the URL in a browser.` };
    }
    return { ok: false, status: res.status, detail: `One-click POST rejected (HTTP ${res.status}). Open the URL in a browser.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `One-click POST failed (${msg}). Open the URL in a browser.` };
  } finally {
    clearTimeout(timer);
  }
}
