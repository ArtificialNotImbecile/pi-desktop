// Chrome native messaging framing: each message is UTF-8 JSON prefixed by its
// byte length as a 32-bit unsigned integer in the platform's native byte order
// (little-endian on all Chrome-supported desktop platforms).

export function encodeMessage(value) {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

// Incrementally parses a byte stream of length-prefixed messages. Feed chunks
// with push(); it returns the array of complete messages decoded so far.
export class MessageParser {
  constructor(onMessage) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      messages.push(parsed);
      if (this.onMessage) this.onMessage(parsed);
    }
    return messages;
  }
}
