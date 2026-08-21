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
    onPromptDispatched?(): void | Promise<void>;
    onPromptAccepted?(): void | Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<string> {
  let port: RemoteSessionPort | undefined;
  let settled: ReturnType<typeof waitForRemotePromptSettled> | undefined;
  let failure: unknown;
  try {
    port = await runtime.openSession(profile, { cwd });
    await callbacks.onPort?.(port);
    const sessionId = await port.createSession(cwd);
    await callbacks.onSessionId?.(sessionId, port);
    settled = waitForRemotePromptSettled(port, callbacks.timeoutMs);
    await callbacks.onPromptDispatched?.();
    await port.prompt(text, [], callbacks.onPromptAccepted);
    await settled.promise;
    return sessionId;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    settled?.cancel();
    await settled?.promise.catch(() => {});
    if (shouldDetach(failure)) await port?.detach().catch(() => {});
    else await port?.close({ abort: false }).catch(() => {});
  }
}

export async function promptManagedRemoteSession(
  runtime: SessionRuntime,
  profile: RemoteProfile,
  sessionId: string,
  text: string,
  callbacks: {
    onPort?(port: RemoteSessionPort): void | Promise<void>;
    onPromptDispatched?(): void | Promise<void>;
    onPromptAccepted?(): void | Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<void> {
  let port: RemoteSessionPort | undefined;
  let settled: ReturnType<typeof waitForRemotePromptSettled> | undefined;
  let failure: unknown;
  try {
    port = await runtime.openSession(profile, { sessionId });
    await callbacks.onPort?.(port);
    settled = waitForRemotePromptSettled(port, callbacks.timeoutMs ?? REMOTE_PROMPT_TIMEOUT_MS);
    await callbacks.onPromptDispatched?.();
    await port.prompt(text, [], callbacks.onPromptAccepted);
    await settled.promise;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    settled?.cancel();
    await settled?.promise.catch(() => {});
    if (shouldDetach(failure)) await port?.detach().catch(() => {});
    else await port?.close({ abort: false }).catch(() => {});
  }
}

export function isDetachedPromptFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code === "prompt-timeout" || code === "daemon-disconnected";
}

/** Pi answered the command itself with success:false; retry remains safe. */
export function isDefinitePromptRejection(error: unknown): boolean {
  return errorCode(error) === "pi-rpc-failed";
}

function shouldDetach(error: unknown): boolean {
  return isDetachedPromptFailure(error);
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

/**
 * Subscribes before a prompt is sent, so even a provider that settles in the
 * same task cannot race past the main process. Closing the renderer does not
 * cancel this waiter; only an explicit abort or a transport/runtime failure
 * changes the remote task's lifecycle.
 */
export function waitForRemotePromptSettled(
  port: Pick<RemoteSessionPort, "eventCursor" | "subscribe">,
  timeoutMs = REMOTE_PROMPT_TIMEOUT_MS
): { promise: Promise<void>; cancel(): void } {
  const cutoff = port.eventCursor;
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
