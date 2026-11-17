import { lookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { VERSION } from "./constants.js";
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

/** A lone UTF-16 surrogate, half of a character such as an emoji. In `u` mode a whole pair is one code point, never matched. */
const LONE_SURROGATE = /\p{Cs}/u;
/** Invisible formatting characters: bidi overrides such as U+202E, zero-width spaces and joiners, byte order marks. */
const FORMAT_CHAR = /\p{Cf}/u;
/** Control characters, C0 and C1, including CR, LF and TAB. */
const CONTROL_CHARS = /\p{Cc}/gu;
/** Control characters other than CR and LF. */
const CONTROL_CHARS_BUT_LINE_BREAKS = /[^\P{Cc}\r\n]/gu;
/** A line break: CRLF, LF or CR. */
const LINE_BREAK = /\r\n|\r|\n/g;

/**
 * True for one plain address: no list separator, whitespace, control or URI/header delimiter,
 * no invisible formatting character (which could make the address read as another one),
 * no lone surrogate, exactly one `@`.
 */
function isSingleAddress(address: string): boolean {
  return (
    address.length <= 254 &&
    !/[\s\p{Cc},;<>"?&%]/u.test(address) &&
    !FORMAT_CHAR.test(address) &&
    !LONE_SURROGATE.test(address) &&
    address.split("@").length === 2 &&
    !address.startsWith("@") &&
    !address.endsWith("@")
  );
}

const MAILTO_SUBJECT_MAX = 200;
const MAILTO_BODY_MAX = 1000;

/** `s` cut to at most `max` UTF-16 units, never between the two halves of a surrogate pair. */
function cut(s: string, max: number): string {
  const out = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

/** `s` without control characters, cut to at most `max` UTF-16 units. */
function cleanText(s: string, max: number): string {
  return cut(s.replace(CONTROL_CHARS, ""), max);
}

/**
 * A mailto body: line breaks kept, as CRLF (RFC 6068), every other control character removed,
 * cut to at most `max` UTF-16 units without splitting a CRLF.
 */
function cleanBody(s: string, max: number): string {
  const out = cut(s.replace(CONTROL_CHARS_BUT_LINE_BREAKS, "").replace(LINE_BREAK, "\r\n"), max);
  return out.endsWith("\r") ? out.slice(0, -1) : out;
}

function parseMailto(uri: string): { address: string; subject?: string; body?: string } | undefined {
  if (!/^mailto:/i.test(uri)) return undefined;
  const rest = uri.slice("mailto:".length);
  const [addrPart, query = ""] = rest.split("?", 2);
  let address: string;
  try {
    address = decodeURIComponent(addrPart ?? "").trim();
  } catch {
    return undefined;
  }
  if (!isSingleAddress(address)) return undefined;
  const params = new URLSearchParams(query);
  const subject = cleanText(params.get("subject") ?? "", MAILTO_SUBJECT_MAX);
  const body = cleanBody(params.get("body") ?? "", MAILTO_BODY_MAX);
  return { address, ...(subject ? { subject } : {}), ...(body ? { body } : {}) };
}

/**
 * Parse List-Unsubscribe / List-Unsubscribe-Post headers into structured info. An https link
 * wins over an http one; the mailto subject and body come without control characters (the body
 * keeps its line breaks, as CRLF), capped at 200 and 1000 characters.
 */
export function parseListUnsubscribe(headers: GraphHeader[] | undefined): UnsubscribeInfo {
  const lu = header(headers, "List-Unsubscribe");
  const post = header(headers, "List-Unsubscribe-Post");
  const info: UnsubscribeInfo = { oneClick: false };
  if (!lu) return info;

  for (const entry of splitListUnsubscribe(lu)) {
    if (/^https:\/\//i.test(entry)) {
      if (!info.https || !/^https:\/\//i.test(info.https)) info.https = entry;
    } else if (/^http:\/\//i.test(entry) && !info.https) {
      // Kept only so that mail_unsubscribe can say why it is not used: plain http links are never opened.
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

/**
 * `s` cut to at most `max` UTF-16 units, then percent-encoded. Never throws: the cut never splits a
 * surrogate pair, and any lone surrogate left becomes U+FFFD (encodeURIComponent throws on one).
 */
function encodeCut(s: string, max = Number.POSITIVE_INFINITY): string {
  return encodeURIComponent(cut(s, max).replace(new RegExp(LONE_SURROGATE, "gu"), "\uFFFD"));
}

/**
 * A `mailto:` link the user can open in their own mail app, built from the header's
 * address, subject and body only. Any other field the sender put in the header (cc, bcc, to)
 * is dropped, control characters are removed from the subject and from the body (whose line
 * breaks are kept, as CRLF), and everything is percent-encoded so nothing can add a query parameter.
 * Never throws, whatever the sender put in the header.
 */
export function buildMailtoUrl(info: UnsubscribeInfo): string | undefined {
  if (!info.mailto) return undefined;
  const address = encodeCut(info.mailto).replace(/%40/g, "@");
  const subject = (info.mailtoSubject ?? "").replace(CONTROL_CHARS, "") || "unsubscribe";
  const body = cleanBody(info.mailtoBody ?? "", MAILTO_BODY_MAX);
  const query = [`subject=${encodeCut(subject, MAILTO_SUBJECT_MAX)}`];
  if (body) query.push(`body=${encodeCut(body)}`);
  return `mailto:${address}?${query.join("&")}`;
}

/** Every address a hostname resolves to, like `dns.lookup(host, { all: true })`. */
export type HostResolver = (hostname: string) => Promise<readonly { address: string; family?: number }[]>;

const lookupAll: HostResolver = (hostname) => lookup(hostname, { all: true });

/**
 * Addresses an email must not make this machine connect to, or the browser open: this host,
 * its local network and other non-public ranges. BlockList also matches IPv4-mapped IPv6
 * addresses (::ffff:a.b.c.d) against the IPv4 rules. NAT64 (64:ff9b::/96), 6to4 and
 * IPv4-translated addresses are not listed: they are judged by the IPv4 address they carry
 * (see `isNonPublic`), since on an IPv6-only network with DNS64 every host resolves to a
 * 64:ff9b:: address.
 */
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network": 0.0.0.0 reaches localhost on Linux and macOS
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, also used by Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata endpoints
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 3], // multicast, reserved and broadcast
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and deprecated IPv4-compatible
  ["64:ff9b:1::", 48], // NAT64, local-use prefix: only reaches a local network's translator
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv6");

/** The eight 16-bit groups of an IPv6 address, or undefined when `address` is not one. */
function ipv6Groups(address: string): number[] | undefined {
  const plain = address.replace(/%.*$/, "");
  if (isIP(plain) !== 6) return undefined;
  let head = plain;
  const tail: number[] = [];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(head);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    head = head.slice(0, dotted.index);
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const groups = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const [left = "", right] = head.split("::");
  if (right === undefined) return [...groups(left), ...tail];
  const l = groups(left);
  const r = [...groups(right), ...tail];
  return [...l, ...new Array<number>(8 - l.length - r.length).fill(0), ...r];
}

/**
 * The IPv4 address carried inside an IPv6 one: NAT64 (64:ff9b::/96, and 64:ff9b:1::/48 with the
 * IPv4 in the last 32 bits), 6to4 (2002::/16), IPv4-translated (::ffff:0:a.b.c.d) and
 * IPv4-mapped (::ffff:a.b.c.d). Undefined for any other address.
 */
export function embeddedIPv4(address: string): string | undefined {
  const g = ipv6Groups(address);
  if (!g) return undefined;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  if (g0 === 0x64 && g1 === 0xff9b && ((g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) || g2 === 1)) return v4(g6, g7);
  if (zeroHead && ((g4 === 0xffff && g5 === 0) || (g4 === 0 && g5 === 0xffff))) return v4(g6, g7);
  if (g0 === 0x2002) return v4(g1, g2);
  return undefined;
}

/** True when `address` is in a non-public range, or is a NAT64, 6to4 or IPv4-translated address carrying a non-public IPv4. */
function isNonPublic(address: string): boolean {
  // Only scoped addresses (link-local, site-local) carry a zone id such as %eth0, and BlockList ignores them.
  if (address.includes("%")) return true;
  const family = isIP(address);
  if (family === 0) return true;
  if (NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6")) return true;
  const inner = family === 6 ? embeddedIPv4(address) : undefined;
  return inner !== undefined && NON_PUBLIC.check(inner, "ipv4");
}

const NON_PUBLIC_WORDS = "a loopback, private, link-local or other non-public address";

/** Why a link must not be used: its host is non-public, or it could not be checked. */
export interface Refusal {
  reason: "non-public" | "unverifiable";
  /** What was found, e.g. "router.example resolves to 192.168.1.1, a loopback, … address". */
  why: string;
}

class RefusedHost extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.why);
  }
}

/**
 * Every address `hostname` resolves to, each with its family, when all of them are public.
 * Throws RefusedHost when the name is local, cannot be resolved, or any address is non-public,
 * since a connection may go to any of them.
 */
async function publicAddresses(hostname: string, resolveHost: HostResolver): Promise<{ address: string; family: number }[]> {
  const name = hostname.replace(/\.$/, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) {
    throw new RefusedHost({ reason: "non-public", why: `${name} points to this computer` });
  }
  let addresses: readonly { address: string }[];
  try {
    addresses = await resolveHost(hostname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RefusedHost({ reason: "unverifiable", why: `${hostname} could not be resolved: ${msg}` });
  }
  if (addresses.length === 0) throw new RefusedHost({ reason: "unverifiable", why: `${hostname} has no address` });
  const blocked = addresses.find((a) => isNonPublic(a.address));
  if (blocked) throw new RefusedHost({ reason: "non-public", why: `${hostname} resolves to ${blocked.address}, ${NON_PUBLIC_WORDS}` });
  return addresses.map((a) => ({ address: a.address, family: isIP(a.address) }));
}

/**
 * Why the unsubscribe link `url` must be neither POSTed to nor handed to a browser, or undefined
 * when its host is public. The URL comes from the email, so its sender must not be able to aim
 * this machine or the user's browser at localhost, the local network or a cloud metadata endpoint.
 * A hostname is refused when any of its addresses is non-public.
 */
export async function checkUnsubscribeLink(url: string, resolveHost: HostResolver = lookupAll): Promise<Refusal | undefined> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { reason: "unverifiable", why: "the URL is not valid" };
  }
  const literal = hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(literal)) return isNonPublic(literal) ? { reason: "non-public", why: `${literal} is ${NON_PUBLIC_WORDS}` } : undefined;
  try {
    await publicAddresses(hostname, resolveHost);
    return undefined;
  } catch (err) {
    if (err instanceof RefusedHost) return err.refusal;
    throw err;
  }
}

/**
 * A `lookup` for the one-click socket: it resolves the host again, refuses the whole request when
 * any address is non-public, and hands the socket only addresses that passed. The connection
 * therefore goes to a checked address even if the name was rebound since `checkUnsubscribeLink`.
 */
function checkedLookup(resolveHost: HostResolver): LookupFunction {
  return (hostname, options, callback) => {
    publicAddresses(hostname, resolveHost).then(
      (addresses) => {
        const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
        const wanted = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        const first = wanted[0];
        if (!first) callback(new RefusedHost({ reason: "unverifiable", why: `${hostname} has no IPv${family} address` }), "", 0);
        else if (options.all) callback(null, wanted);
        else callback(null, first.address, first.family);
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), "", 0),
    );
  };
}

/** Sends one HTTPS request: `https.request`, or a stand-in in tests. */
export type RequestFn = (options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;

/** How the one-click POST reaches the network. Tests replace both so that nothing leaves the machine. */
export interface UnsubscribeNetwork {
  /** Resolves unsubscribe hosts, for the check and for the connection. Default: `dns.lookup` with `all: true`. */
  resolveHost?: HostResolver;
  /** Sends the POST. Default: `https.request`. */
  request?: RequestFn;
}

export interface OneClickResult {
  ok: boolean;
  status?: number;
  detail: string;
  /** Set when nothing was sent because the host is non-public or could not be checked. */
  refusal?: Refusal;
}

const ONE_CLICK_TIMEOUT_MS = 15_000;

/**
 * Perform an RFC 8058 one-click unsubscribe POST over https.
 * No cookies, no auth, no redirects followed, the response body is discarded unread. Success = any 2xx.
 * Nothing is sent when the host is, or resolves to, a non-public address, before the request
 * (`checkUnsubscribeLink`) or when the socket connects (`checkedLookup`).
 */
export async function oneClickPost(url: string, net: UnsubscribeNetwork = {}): Promise<OneClickResult> {
  const resolveHost = net.resolveHost ?? lookupAll;
  const request = net.request ?? httpsRequest;
  const refused = (refusal: Refusal): OneClickResult => ({ ok: false, detail: `Refused the one-click POST: ${refusal.why}.`, refusal });

  const refusal = await checkUnsubscribeLink(url, resolveHost);
  if (refusal) return refused(refusal);
  const target = new URL(url);
  if (target.protocol !== "https:") return { ok: false, detail: "Refused the one-click POST: the URL is not https." };

  const failed = (msg: string): OneClickResult => ({ ok: false, detail: `One-click POST failed (${msg}). Open the URL in a browser.` });
  return new Promise<OneClickResult>((resolve) => {
    let req: ClientRequest | undefined;
    const timer = setTimeout(() => {
      settle(failed(`no answer within ${ONE_CLICK_TIMEOUT_MS / 1000} s`));
      req?.destroy();
    }, ONE_CLICK_TIMEOUT_MS);
    function settle(result: OneClickResult): void {
      clearTimeout(timer);
      resolve(result);
    }
    try {
      req = request(
        {
          protocol: "https:",
          hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
          port: target.port ? Number(target.port) : 443,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": String(Buffer.byteLength(ONE_CLICK_BODY)),
            "User-Agent": `mail-mcp/${VERSION}`,
          },
          lookup: checkedLookup(resolveHost),
          agent: false,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.on("error", () => {});
          res.destroy(); // the body is never read
          if (status >= 200 && status < 300) {
            settle({ ok: true, status, detail: `One-click POST accepted (HTTP ${status}).` });
          } else if (status >= 300 && status < 400) {
            settle({ ok: false, status, detail: `The server answered with a redirect (HTTP ${status}), which is not RFC 8058 compliant. Open the URL in a browser.` });
          } else {
            settle({ ok: false, status, detail: `One-click POST rejected (HTTP ${status}). Open the URL in a browser.` });
          }
        },
      );
      req.on("error", (err) => settle(err instanceof RefusedHost ? refused(err.refusal) : failed(err.message)));
      req.end(ONE_CLICK_BODY);
    } catch (err) {
      settle(failed(err instanceof Error ? err.message : String(err)));
    }
  });
}
