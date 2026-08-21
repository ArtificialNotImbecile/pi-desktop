import { PiRemoteError } from "../agent/extensions/piRemote/errors.js";
import type {
  RemoteProfile,
  RemoteRuntimeManager,
  RemoteSessionEvent,
  RemoteSessionPort
} from "../agent/extensions/piRemote/types.js";

export const REMOTE_PROMPT_TIMEOUT_MS = 30 * 60_000;

type SessionRuntime = Pick<RemoteRuntimeManager, "openSession">;

export async function startManagedRemoteSession(
  runtime: SessionRuntime,
  profile: RemoteProfile,
  cwd: string,
  text: string,
  callbacks: {
    onPort?(port: RemoteSessionPort): void | Promise<void>;
    onSessionId?(sessionId: string, port: RemoteSessionPort): void | Promise<void>;
    onReconnect?(error: unknown): void | Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<string> {
  const state: { port?: RemoteSessionPort } = {};
  try {
    state.port = await runtime.openSession(profile, { cwd });
    await callbacks.onPort?.(state.port);
    const sessionId = await state.port.createSession(cwd);
    await callbacks.onSessionId?.(sessionId, state.port);
    await settleAcrossReconnects({
      runtime,
      profile,
      sessionId,
      state,
      timeoutMs: callbacks.timeoutMs,
      send: () => state.port!.prompt(text),
      onPort: callbacks.onPort,
      onReconnect: callbacks.onReconnect
    });
    return sessionId;
  } finally {
    await state.port?.close({ abort: false }).catch(() => {});
  }
}

export async function promptManagedRemoteSession(
  runtime: SessionRuntime,
  profile: RemoteProfile,
  sessionId: string,
  text: string,
  onPort: (port: RemoteSessionPort) => void | Promise<void> = () => {},
  timeoutMs = REMOTE_PROMPT_TIMEOUT_MS,
  onReconnect: (error: unknown) => void | Promise<void> = () => {}
): Promise<void> {
  const state: { port?: RemoteSessionPort } = {};
  try {
    state.port = await runtime.openSession(profile, { sessionId });
    await onPort(state.port);
    await settleAcrossReconnects({
      runtime,
      profile,
      sessionId,
      state,
      timeoutMs,
      send: () => state.port!.prompt(text),
      onPort,
      onReconnect
    });
  } finally {
    await state.port?.close({ abort: false }).catch(() => {});
  }
}

async function settleAcrossReconnects(options: {
  runtime: SessionRuntime;
  profile: RemoteProfile;
  sessionId: string;
  state: { port?: RemoteSessionPort };
  timeoutMs?: number;
  send(): Promise<void>;
  onPort?(port: RemoteSessionPort): void | Promise<void>;
  onReconnect?(error: unknown): void | Promise<void>;
}): Promise<void> {
  let send: (() => Promise<void>) | undefined = options.send;
  let cutoff = options.state.port?.eventCursor ?? 0;
  let reconnectAttempt = 0;
  while (true) {
    const port = options.state.port;
    if (!port) throw new PiRemoteError("daemon-disconnected", "Remote daemon transport is unavailable.", { phase: "protocol", retryable: true });
    const settled = waitForRemotePromptSettled(port, options.timeoutMs, cutoff);
    try {
      if (send) {
        const start = send;
        send = undefined;
        await start();
      }
      await settled.promise;
      return;
    } catch (error) {
      if (!shouldReconnect(error)) throw error;
      cutoff = port.eventCursor;
      await options.onReconnect?.(error);
      await port.detach().catch(() => {});
      options.state.port = undefined;
      while (!options.state.port) {
        try {
          const replacement = await options.runtime.openSession(options.profile, {
            sessionId: options.sessionId,
            afterSeq: cutoff
          });
          try {
            await options.onPort?.(replacement);
            options.state.port = replacement;
            reconnectAttempt = 0;
          } catch (replacementError) {
            await replacement.detach().catch(() => {});
            throw replacementError;
          }
        } catch (reconnectError) {
          if (!isRetryable(reconnectError)) throw reconnectError;
          reconnectAttempt += 1;
          await reconnectDelay(reconnectAttempt);
        }
      }
    } finally {
      settled.cancel();
      await settled.promise.catch(() => {});
    }
  }
}

function shouldReconnect(error: unknown): boolean {
  const code = errorCode(error);
  return code === "prompt-timeout" || code === "daemon-disconnected";
}

function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true);
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

async function reconnectDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5))));
}

/**
 * Subscribes before a prompt is sent, so even a provider that settles in the
 * same task cannot race past the main process. Closing the renderer does not
 * cancel this waiter; only an explicit abort or a transport/runtime failure
 * changes the remote task's lifecycle.
 */
export function waitForRemotePromptSettled(
  port: Pick<RemoteSessionPort, "eventCursor" | "subscribe">,
  timeoutMs = REMOTE_PROMPT_TIMEOUT_MS,
  cutoff = port.eventCursor
): { promise: Promise<void>; cancel(): void } {
  let cancel = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (action: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new PiRemoteError(
      "prompt-timeout",
      "Remote prompt did not settle within 30 minutes.",
      { phase: "session", retryable: true }
    ))), timeoutMs);
    timer.unref();

    unsubscribe = port.subscribe((event: RemoteSessionEvent) => {
      if (event.seq <= cutoff) return;
      const raw = event.type === "rpc.message" && event.data && typeof event.data === "object"
        ? event.data as Record<string, unknown>
        : undefined;
      if (raw?.type === "agent_settled") {
        finish(resolve);
        return;
      }
      if (event.type === "rpc.exit" || event.type === "rpc.error" || event.type === "rpc.protocol_error" || event.type === "transport.disconnected") {
        const disconnected = event.type === "transport.disconnected";
        finish(() => reject(new PiRemoteError(
          disconnected ? "daemon-disconnected" : "remote-process-exited",
          disconnected
            ? "Remote daemon connection closed before the prompt settled."
            : "Remote Pi RPC process exited before the prompt settled.",
          { phase: disconnected ? "protocol" : "session", retryable: true }
        )));
      }
    });

    cancel = () => finish(resolve);
    if (done) unsubscribe();
  });
  return { promise, cancel: () => cancel() };
}
