import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { RequestFn } from "../src/unsubscribe.js";

export interface SentRequest {
  options: RequestOptions;
  body: string;
  /** Where the socket connected: the answer of `options.lookup`, or the host when it is an IP literal. */
  connectedTo: string[];
  /** True once the response was destroyed, i.e. its body was discarded unread. */
  responseDestroyed: boolean;
}

/**
 * A stand-in for `https.request` that behaves like Node's: a hostname goes through `options.lookup`
 * with `all: true`, and an error from it fails the request before any connection is made.
 * `answer` is the HTTP status to answer, an Error to fail with once connected, or "hang" to never answer.
 * `attempts` holds every request created, `sent` only the ones that connected.
 */
export function fakeRequest(answer: number | Error | "hang" = 200) {
  const attempts: RequestOptions[] = [];
  const sent: SentRequest[] = [];
  const destroyed: RequestOptions[] = [];
  const request = ((options: RequestOptions, onResponse: (res: unknown) => void) => {
    attempts.push(options);
    let isDestroyed = false;
    const req = Object.assign(new EventEmitter(), {
      destroy(err?: Error) {
        isDestroyed = true;
        destroyed.push(options);
        if (err) queueMicrotask(() => req.emit("error", err));
        return req;
      },
      end(body = "") {
        const connect = (addresses: string[]) => {
          if (isDestroyed) return;
          const entry: SentRequest = { options, body, connectedTo: addresses, responseDestroyed: false };
          sent.push(entry);
          if (answer === "hang") return;
          if (answer instanceof Error) {
            req.emit("error", answer);
            return;
          }
          const res = Object.assign(new EventEmitter(), {
            statusCode: answer,
            destroy() {
              entry.responseDestroyed = true;
            },
          });
          onResponse(res);
        };
        const host = String(options.hostname);
        if (isIP(host)) {
          queueMicrotask(() => connect([host]));
        } else {
          options.lookup!(host, { all: true }, (err, addresses) => {
            if (err) req.emit("error", err);
            else connect((addresses as { address: string }[]).map((a) => a.address));
          });
        }
        return req;
      },
    });
    return req;
  }) as unknown as RequestFn;
  return { request, attempts, sent, destroyed };
}
