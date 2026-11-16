/**
 * Sign-in driven by the assistant instead of a terminal: at most one browser sign-in at a time,
 * reported in short waits so a tool call never outlasts the client's timeout.
 */

export type LoginStatus =
  | { status: "signed_in"; account: string }
  | { status: "pending"; url: string }
  | { status: "failed"; detail: string };

export interface LoginDeps {
  signedInAccount(): Promise<string | undefined>;
  loginInteractive(openBrowser: (url: string) => Promise<void>): Promise<{ username: string }>;
  openBrowser(url: string): Promise<void>;
  cancel(authUrl: string): Promise<void>;
  waitMs: number; // production: LOGIN_WAIT_MS
  giveUpMs: number; // production: LOGIN_GIVE_UP_MS
}

type Outcome = { ok: true; account: string } | { ok: false; detail: string };

/** One browser sign-in, from the call that starts it until it ends. */
interface Flight {
  /** Resolves with the authorization URL once MSAL has built it. */
  urlKnown: Promise<string>;
  /** Resolves, never rejects, when the sign-in ends. */
  done: Promise<Outcome>;
  outcome?: Outcome;
  giveUpTimer?: NodeJS.Timeout;
}

export class LoginFlow {
  /** The sign-in in progress, or one that failed while no call was waiting and has not been reported yet. */
  private flight: Flight | undefined;

  constructor(private readonly deps: LoginDeps) {}

  async start(): Promise<LoginStatus> {
    const account = await this.deps.signedInAccount();
    if (account !== undefined) {
      if (this.flight?.outcome) this.flight = undefined; // an earlier failure no longer matters
      return { status: "signed_in", account };
    }
    // No await between this check and begin(): two calls at the same moment share one sign-in.
    return this.report(this.flight ?? this.begin());
  }

  private begin(): Flight {
    let urlKnown!: (url: string) => void;
    let done!: (outcome: Outcome) => void;
    const flight: Flight = {
      urlKnown: new Promise<string>((resolve) => { urlKnown = resolve; }),
      done: new Promise<Outcome>((resolve) => { done = resolve; }),
    };
    let url: string | undefined;
    const openBrowser = async (authUrl: string): Promise<void> => {
      if (url === undefined) {
        url = authUrl;
        urlKnown(authUrl);
        flight.giveUpTimer = setTimeout(() => this.giveUp(flight, authUrl), this.deps.giveUpMs);
        flight.giveUpTimer.unref();
      }
      try {
        await this.deps.openBrowser(authUrl);
      } catch {
        // No browser (headless, no display…): the URL is still handed to the assistant.
      }
    };
    const end = (outcome: Outcome): void => {
      clearTimeout(flight.giveUpTimer);
      flight.outcome = outcome;
      // A success needs no report (the next call finds the account); a failure waits for one.
      if (outcome.ok && this.flight === flight) this.flight = undefined;
      done(outcome);
    };
    this.flight = flight;
    void new Promise<{ username: string }>((resolve) => resolve(this.deps.loginInteractive(openBrowser))).then(
      (result) => end({ ok: true, account: result.username }),
      (err: unknown) => end({ ok: false, detail: firstLine(err) }),
    );
    return flight;
  }

  /**
   * Abandons a sign-in nobody finished: frees MSAL's loopback port, and lets the next call start afresh.
   * Silent: the cancellation is not reported as a failure. A call waiting at this moment sees the sign-in end.
   */
  private giveUp(flight: Flight, authUrl: string): void {
    if (this.flight === flight) this.flight = undefined;
    void quietly(() => this.deps.cancel(authUrl));
  }

  private async report(flight: Flight): Promise<LoginStatus> {
    const ended = await within(flight.done, this.deps.waitMs);
    // Still running: answer pending. That answer must carry the URL, so if MSAL has not built it yet, wait for it.
    const next = ended ?? (await Promise.race([flight.done, flight.urlKnown]));
    if (typeof next === "string") return { status: "pending", url: next };
    if (this.flight === flight) this.flight = undefined; // reported: the next call starts fresh
    return next.ok ? { status: "signed_in", account: next.account } : { status: "failed", detail: next.detail };
  }
}

const CANCEL_BODY = "error=login_timeout&error_description=Sign-in+was+not+completed+in+time";

/** Ends an abandoned MSAL loopback sign-in by posting an OAuth error to its redirect URI. */
export async function cancelLoopback(authUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const port = loopbackPort(authUrl);
  if (port === undefined) return;
  // MSAL listens on 127.0.0.1 only, while "localhost" may resolve to ::1.
  const res = await fetchImpl(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: CANCEL_BODY,
    signal: AbortSignal.timeout(5_000),
  });
  await res.body?.cancel();
}

/** The port of the URL's redirect_uri when that is an http loopback address; otherwise undefined. */
function loopbackPort(authUrl: string): string | undefined {
  let redirect: URL;
  try {
    redirect = new URL(new URL(authUrl).searchParams.get("redirect_uri") ?? "");
  } catch {
    return undefined;
  }
  const loopback = redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1";
  return redirect.protocol === "http:" && loopback && redirect.port !== "" ? redirect.port : undefined;
}

/** First line of an error's message: Microsoft appends trace and correlation IDs on later lines. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split(/[\r\n]/, 1)[0]?.trim() || "Sign-in failed.";
}

/** The promise's value, or undefined if it takes longer than ms. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function quietly(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Best effort.
  }
}
