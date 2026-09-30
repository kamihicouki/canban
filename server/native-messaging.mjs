export const NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;

function frame(payload) {
  if (payload.byteLength > NATIVE_MESSAGE_MAX_BYTES) throw new Error('Chrome native message is too large');
  const out = Buffer.allocUnsafe(payload.byteLength + 4);
  out.writeUInt32LE(payload.byteLength, 0);
  payload.copy(out, 4);
  return out;
}

export function encodeNativeResponse(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.byteLength <= NATIVE_MESSAGE_MAX_BYTES) return [frame(payload)];

  const total = Math.ceil(payload.byteLength / CHUNK_BYTES);
  const frames = [];
  for (let index = 0; index < total; index++) {
    const data = payload.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, payload.byteLength));
    frames.push(frame(Buffer.from(JSON.stringify({ __canbanChunk: 1, id: message.id, index, total, data: data.toString('base64') }), 'utf8')));
  }
  return frames;
}

export class FrameDecoder {
  constructor(maxBytes = NATIVE_MESSAGE_MAX_BYTES) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const messages = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size > this.maxBytes) throw new Error(`Chrome native message exceeds ${this.maxBytes} bytes`);
      if (this.buffer.length < size + 4) break;
      const payload = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      messages.push(JSON.parse(payload.toString('utf8')));
    }
    return messages;
  }
}
