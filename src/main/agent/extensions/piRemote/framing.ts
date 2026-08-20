import { PiRemoteError } from "./errors.js";
import { DEFAULT_MAX_FRAME_LENGTH } from "./types.js";

export function encodeJsonFrame(value: unknown, maxFrameLength = DEFAULT_MAX_FRAME_LENGTH): Uint8Array {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > maxFrameLength) {
    throw new PiRemoteError("frame-size-invalid", `Protocol frame length ${payload.length} is outside the configured limit.`, {
      phase: "protocol",
      safeDetails: { length: payload.length, maxFrameLength }
    });
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class JsonFrameDecoder<T = unknown> {
  private buffer = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly maxFrameLength = DEFAULT_MAX_FRAME_LENGTH) {}

  push(chunk: Uint8Array): T[] {
    if (this.ended) throw new PiRemoteError("frame-after-end", "Protocol data arrived after stream end.", { phase: "protocol" });
    if (chunk.byteLength === 0) return [];
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, Buffer.from(chunk)], this.buffer.length + chunk.byteLength);
    const values: T[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > this.maxFrameLength) {
        throw new PiRemoteError("frame-size-invalid", `Peer declared invalid protocol frame length ${length}.`, {
          phase: "protocol",
          safeDetails: { length, maxFrameLength: this.maxFrameLength }
        });
      }
      if (this.buffer.length < length + 4) break;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try {
        values.push(JSON.parse(payload.toString("utf8")) as T);
      } catch (error) {
        throw new PiRemoteError("frame-json-invalid", "Peer sent a protocol frame that is not valid UTF-8 JSON.", {
          phase: "protocol",
          cause: error
        });
      }
    }
    return values;
  }

  end(): void {
    this.ended = true;
    if (this.buffer.length !== 0) {
      throw new PiRemoteError("frame-truncated", "Protocol stream ended in the middle of a frame.", {
        phase: "protocol",
        safeDetails: { bufferedBytes: this.buffer.length }
      });
    }
  }
}
