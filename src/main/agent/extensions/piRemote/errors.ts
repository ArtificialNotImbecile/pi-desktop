import type { SerializedPiRemoteError } from "./types.js";

export type PiRemoteErrorPhase =
  | "profile"
  | "ssh"
  | "probe"
  | "install"
  | "runtime"
  | "protocol"
  | "session"
  | "egress"
  | "auth"
  | "config"
  | "file";

export interface PiRemoteErrorOptions {
  phase: PiRemoteErrorPhase;
  retryable?: boolean;
  remediation?: string;
  safeDetails?: Record<string, string | number | boolean | null>;
  cause?: unknown;
}

export class PiRemoteError extends Error {
  readonly code: string;
  readonly phase: PiRemoteErrorPhase;
  readonly retryable: boolean;
  readonly remediation?: string;
  readonly safeDetails?: Record<string, string | number | boolean | null>;

  constructor(code: string, message: string, options: PiRemoteErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PiRemoteError";
    this.code = code;
    this.phase = options.phase;
    this.retryable = options.retryable ?? false;
    this.remediation = options.remediation;
    this.safeDetails = options.safeDetails;
  }

  serialize(): SerializedPiRemoteError {
    return {
      name: "PiRemoteError",
      code: this.code,
      message: this.message,
      phase: this.phase,
      retryable: this.retryable,
      ...(this.remediation ? { remediation: this.remediation } : {}),
      ...(this.safeDetails ? { safeDetails: this.safeDetails } : {})
    };
  }

  static from(value: SerializedPiRemoteError): PiRemoteError {
    return new PiRemoteError(value.code, value.message, {
      phase: value.phase as PiRemoteErrorPhase,
      retryable: value.retryable,
      remediation: value.remediation,
      safeDetails: value.safeDetails
    });
  }
}

export function asPiRemoteError(error: unknown, fallback: { code: string; message: string; phase: PiRemoteErrorPhase }): PiRemoteError {
  if (error instanceof PiRemoteError) return error;
  return new PiRemoteError(fallback.code, fallback.message, {
    phase: fallback.phase,
    cause: error
  });
}
