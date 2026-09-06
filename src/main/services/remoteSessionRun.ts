import { PiRemoteError } from "../agent/extensions/piRemote/errors.js";
import type {
  RemoteProfile,
  RemoteRuntimeManager,
  RemoteSessionEvent,
  RemoteSessionPort
} from "../agent/extensions/piRemote/types.js";
import type { RemoteModelSelection } from "./remoteModelConfig.js";

export const REMOTE_PROMPT_TIMEOUT_MS = 30 * 60_000;

type SessionRuntime = Pick<RemoteRuntimeManager, "openSession">;

type PromptCallbacks = {
  onPort?(port: RemoteSessionPort): void | Promise<void>;
  onPromptDispatched?(): void | Promise<void>;
  onPromptAccepted?(): void | Promise<void>;
  /** Receives every Pi RPC payload the port publishes after the prompt is armed. */
  onRpcMessage?(message: unknown): void;
  /** Pins the session to this model before the prompt is sent. */
  model?: RemoteModelSelection;
  timeoutMs?: number;
};

export async function startManagedRemoteSession(
  runtime: SessionRuntime,
  profile: RemoteProfile,
  cwd: string,
  text: string,
  callbacks: PromptCallbacks & {
    onSessionId?(sessionId: string, port: RemoteSessionPort): void | Promise<void>;
  } = {}
): Promise<string> {
  let port: RemoteSessionPort | undefined;
  let settled: ReturnType<typeof waitForRemotePromptSettled> | undefined;
  let unsubscribeLive = () => {};
  let failure: unknown;
  try {
    port = await runtime.openSession(profile, { cwd });
    await callbacks.onPort?.(port);
    const sessionId = await port.createSession(cwd);
    await callbacks.onSessionId?.(sessionId, port);
    if (callbacks.model) await applyModelSelection(port, callbacks.model);
    settled = waitForRemotePromptSettled(port, callbacks.timeoutMs);
    unsubscribeLive = subscribeRpcMessages(port, callbacks.onRpcMessage);
    await port.prompt(text, [], callbacks.onPromptAccepted, callbacks.onPromptDispatched);
    await settled.promise;
    return sessionId;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    unsubscribeLive();
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
  callbacks: PromptCallbacks = {}
): Promise<void> {
  let port: RemoteSessionPort | undefined;
  let settled: ReturnType<typeof waitForRemotePromptSettled> | undefined;
  let unsubscribeLive = () => {};
  let failure: unknown;
  try {
    port = await runtime.openSession(profile, { sessionId });
    await callbacks.onPort?.(port);
    if (callbacks.model) await applyModelSelection(port, callbacks.model);
    settled = waitForRemotePromptSettled(port, callbacks.timeoutMs ?? REMOTE_PROMPT_TIMEOUT_MS);
    unsubscribeLive = subscribeRpcMessages(port, callbacks.onRpcMessage);
    await port.prompt(text, [], callbacks.onPromptAccepted, callbacks.onPromptDispatched);
    await settled.promise;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    unsubscribeLive();
    settled?.cancel();
    await settled?.promise.catch(() => {});
    if (shouldDetach(failure)) await port?.detach().catch(() => {});
    else await port?.close({ abort: false }).catch(() => {});
  }
}

/**
 * A resumed session keeps whatever model its last turn used and a new one
 * starts on the host's default, so the selection is applied explicitly. The
 * model must be selectable: a failure here is Pi rejecting the switch, which
 * surfaces as a definite rejection and leaves the draft for the user. The
 * thinking level is a preference on top of that and is not allowed to block
 * the turn when the model does not accept it.
 */
async function applyModelSelection(port: RemoteSessionPort, model: RemoteModelSelection): Promise<void> {
  await port.setModel(model.providerId, model.modelId);
  if (model.thinkingLevel) await port.setThinking(model.thinkingLevel).catch(() => {});
}

/**
 * Forwards Pi's own RPC payloads, skipping anything the port replays from before
 * this prompt: a reconnected client is handed the daemon's buffered history,
 * which belongs to earlier turns.
 */
function subscribeRpcMessages(
  port: Pick<RemoteSessionPort, "eventCursor" | "subscribe">,
  onRpcMessage: ((message: unknown) => void) | undefined
): () => void {
  if (!onRpcMessage) return () => {};
  const cutoff = port.eventCursor;
  return port.subscribe((event: RemoteSessionEvent) => {
    if (event.seq <= cutoff || event.type !== "rpc.message") return;
    try { onRpcMessage(event.data); } catch { /* a projection error must not disturb the protocol */ }
  });
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
