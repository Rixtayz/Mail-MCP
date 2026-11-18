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
  /** Opens the URL in the browser. May resolve to a function that removes what opening left behind (a sign-in page), run when the sign-in ends. */
  openBrowser(url: string): Promise<(() => Promise<void>) | void>;
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
  url?: string;
  outcome?: Outcome;
  giveUpTimer?: NodeJS.Timeout;
  /** Given up or cancelled: MSAL's loopback has been, or will be, told to stop. */
  abandoned?: true;
  /** What openBrowser left behind, removed when the sign-in ends or is abandoned. */
  leftovers: (() => Promise<void>)[];
  tidied?: true;
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

  /**
   * Cancels the sign-in in progress, if any, the way a give-up does, and resolves once it has ended (or after
   * waitMs): MSAL's loopback listener is closed, so finishing the sign-in in the browser afterwards cannot sign
   * the user in. mail_logout calls this first. If MSAL has not built the sign-in URL yet, the browser never opens.
   */
  async cancel(): Promise<void> {
    const flight = this.flight;
    if (!flight) return;
    await this.abandon(flight);
    await within(flight.done, this.deps.waitMs);
  }

  private begin(): Flight {
    let urlKnown!: (url: string) => void;
    let done!: (outcome: Outcome) => void;
    const flight: Flight = {
      urlKnown: new Promise<string>((resolve) => { urlKnown = resolve; }),
      done: new Promise<Outcome>((resolve) => { done = resolve; }),
      leftovers: [],
    };
    const openBrowser = async (authUrl: string): Promise<void> => {
      if (flight.url === undefined) {
        flight.url = authUrl;
        if (flight.abandoned) {
          // Cancelled before MSAL built the URL: stop the loopback now, and open nothing.
          await quietly(() => this.deps.cancel(authUrl));
          return;
        }
        urlKnown(authUrl);
        flight.giveUpTimer = setTimeout(() => void this.abandon(flight), this.deps.giveUpMs);
        flight.giveUpTimer.unref();
      }
      if (flight.abandoned) return;
      try {
        const leftover = await this.deps.openBrowser(authUrl);
        if (leftover) {
          flight.leftovers.push(leftover);
          if (flight.tidied) this.tidy(flight); // the sign-in ended while the browser was opening
        }
      } catch {
        // No browser (headless, no display…): the URL is still handed to the assistant.
      }
    };
    const end = (outcome: Outcome): void => {
      clearTimeout(flight.giveUpTimer);
      flight.outcome = outcome;
      this.tidy(flight);
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
   * Abandons a sign-in nobody finished (the give-up timer, or cancel()): frees MSAL's loopback port, removes the
   * sign-in page, and lets the next call start afresh. Silent: the cancellation is not reported as a failure.
   * A call waiting at this moment sees the sign-in end. Resolves once the loopback has been told to stop.
   */
  private async abandon(flight: Flight): Promise<void> {
    if (this.flight === flight) this.flight = undefined;
    if (flight.abandoned) return;
    flight.abandoned = true;
    clearTimeout(flight.giveUpTimer);
    this.tidy(flight);
    // Without a URL, openBrowser stops the loopback when MSAL hands it one. After an outcome, it is closed already.
    const url = flight.url;
    if (url !== undefined && flight.outcome === undefined) await quietly(() => this.deps.cancel(url));
  }

  /** Removes what opening the browser left behind, now and for anything that finishes opening later. */
  private tidy(flight: Flight): void {
    flight.tidied = true;
    for (const leftover of flight.leftovers.splice(0)) void quietly(leftover);
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

/** The OAuth error MSAL's loopback server is handed to end a sign-in nobody finished. */
function cancelBody(state: string | null): string {
  const params = new URLSearchParams({ error: "login_timeout", error_description: "Sign-in was not completed in time" });
  // msal-node 7.2 ignores a callback whose state is not the one of the pending request, so echo it back.
  if (state) params.set("state", state);
  return params.toString();
}

/** Ends an abandoned MSAL loopback sign-in by posting an OAuth error (carrying the request's state) to its redirect URI. */
export async function cancelLoopback(authUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const port = loopbackPort(authUrl);
  if (port === undefined) return;
  // MSAL listens on 127.0.0.1 only, while "localhost" may resolve to ::1.
  const res = await fetchImpl(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: cancelBody(new URL(authUrl).searchParams.get("state")),
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
