const partSize = 5 * 1024 * 1024;
const metadataLimit = 1024 * 1024;
const maximumDepth = 128;
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64Values = new Int16Array(128).fill(-1);
for (let index = 0; index < base64Alphabet.length; index += 1) {
  base64Values[base64Alphabet.charCodeAt(index)] = index;
}

type JsonPathPart = string | number;

interface ObjectFrame {
  type: "object";
  path: JsonPathPart[];
  state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
  keys: Set<string>;
  currentKey?: string;
}

interface ArrayFrame {
  type: "array";
  path: JsonPathPart[];
  state: "valueOrEnd" | "value" | "commaOrEnd";
  index: number;
}

type Frame = ObjectFrame | ArrayFrame;

export class PublishStreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PendingTarball {
  readonly filename: string;
  readonly key: string;
  readonly length: number;
  readonly shasum: string;
  readonly integrity: string;
  complete(): Promise<R2Object>;
  abort(): Promise<void>;
}

export interface ParsedPublishRequest {
  readonly document: unknown;
  readonly tarball: PendingTarball;
}

function badJson(message = "request body must be valid JSON"): PublishStreamError {
  return new PublishStreamError(400, "bad_request", message);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  return btoa(binary);
}

function digestStream(algorithm: string): DigestStream {
  const constructor = (crypto as Crypto & { DigestStream: typeof DigestStream }).DigestStream;
  return new constructor(algorithm);
}

class MultipartTarball implements PendingTarball {
  readonly key: string;
  readonly filename: string;
  readonly #upload: R2MultipartUpload;
  readonly #sha1 = digestStream("SHA-1");
  readonly #sha512 = digestStream("SHA-512");
  readonly #sha1Writer = this.#sha1.getWriter();
  readonly #sha512Writer = this.#sha512.getWriter();
  readonly #parts: R2UploadedPart[] = [];
  #buffer = new Uint8Array(partSize);
  #bufferLength = 0;
  #quartet: number[] = [];
  #base64Ended = false;
  #finished = false;
  #aborted = false;
  #length = 0;
  #shasum?: string;
  #integrity?: string;

  private constructor(upload: R2MultipartUpload, key: string, filename: string) {
    this.#upload = upload;
    this.key = key;
    this.filename = filename;
  }

  static async create(
    bucket: R2Bucket,
    packageName: string,
    filename: string,
  ): Promise<MultipartTarball> {
    const key = `packages/${encodeURIComponent(packageName)}/${crypto.randomUUID()}.tgz`;
    const upload = await bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    return new MultipartTarball(upload, key, filename);
  }

  get length(): number {
    this.#assertFinished();
    return this.#length;
  }

  get shasum(): string {
    this.#assertFinished();
    return this.#shasum ?? "";
  }

  get integrity(): string {
    this.#assertFinished();
    return this.#integrity ?? "";
  }

  async writeBase64(value: string): Promise<void> {
    if (this.#finished || this.#aborted) throw new Error("tarball upload is no longer writable");
    for (const character of value) {
      const characterCode = character.charCodeAt(0);
      if (
        characterCode === 0x09 ||
        characterCode === 0x0a ||
        characterCode === 0x0d ||
        characterCode === 0x20
      ) {
        continue;
      }
      if (this.#base64Ended) {
        throw new PublishStreamError(400, "bad_request", "tarball attachment is not valid base64");
      }
      if (character === "=") {
        this.#quartet.push(-1);
      } else {
        const valueIndex =
          characterCode < base64Values.length ? (base64Values[characterCode] ?? -1) : -1;
        if (valueIndex === -1) {
          throw new PublishStreamError(
            400,
            "bad_request",
            "tarball attachment is not valid base64",
          );
        }
        this.#quartet.push(valueIndex);
      }
      if (this.#quartet.length === 4) {
        const decoded = this.#decodeQuartet(true);
        const pending = this.#writeBytes(decoded);
        if (pending !== undefined) await pending;
      }
    }
  }

  async finishBase64(): Promise<void> {
    if (this.#finished) return;
    if (this.#quartet.length === 1 || this.#quartet.some((value) => value < 0)) {
      throw new PublishStreamError(400, "bad_request", "tarball attachment is not valid base64");
    }
    if (this.#quartet.length > 0) {
      const decoded = this.#decodeQuartet(false);
      const pending = this.#writeBytes(decoded);
      if (pending !== undefined) await pending;
    }

    if (this.#bufferLength > 0) {
      await this.#uploadPart(this.#buffer.slice(0, this.#bufferLength));
      this.#bufferLength = 0;
    }
    if (this.#length === 0) {
      throw new PublishStreamError(400, "bad_request", "tarball attachment must not be empty");
    }

    await Promise.all([this.#sha1Writer.close(), this.#sha512Writer.close()]);
    const [sha1, sha512] = await Promise.all([this.#sha1.digest, this.#sha512.digest]);
    this.#shasum = hex(sha1);
    this.#integrity = `sha512-${base64(sha512)}`;
    this.#finished = true;
  }

  async complete(): Promise<R2Object> {
    this.#assertFinished();
    if (this.#aborted) throw new Error("tarball upload was aborted");
    return this.#upload.complete(this.#parts);
  }

  async abort(): Promise<void> {
    if (this.#aborted) return;
    this.#aborted = true;
    const reason = new Error("tarball upload aborted");
    await Promise.allSettled([
      this.#upload.abort(),
      this.#sha1Writer.abort(reason),
      this.#sha512Writer.abort(reason),
      this.#sha1.digest,
      this.#sha512.digest,
    ]);
  }

  #decodeQuartet(padded: boolean): number[] {
    const [first, second, third = -1, fourth = -1] = this.#quartet;
    this.#quartet = [];
    if (first === undefined || second === undefined || first < 0 || second < 0) {
      throw new PublishStreamError(400, "bad_request", "tarball attachment is not valid base64");
    }

    if (third < 0) {
      if ((padded && fourth !== -1) || (!padded && this.#base64Ended) || (second & 0x0f) !== 0) {
        throw new PublishStreamError(400, "bad_request", "tarball attachment is not valid base64");
      }
      this.#base64Ended = true;
      return [(first << 2) | (second >> 4)];
    }

    if (fourth < 0) {
      if ((third & 0x03) !== 0) {
        throw new PublishStreamError(400, "bad_request", "tarball attachment is not valid base64");
      }
      const bytes = [(first << 2) | (second >> 4), ((second & 0x0f) << 4) | (third >> 2)];
      this.#base64Ended = true;
      return bytes;
    }

    return [
      (first << 2) | (second >> 4),
      ((second & 0x0f) << 4) | (third >> 2),
      ((third & 0x03) << 6) | fourth,
    ];
  }

  #writeBytes(bytes: readonly number[]): Promise<void> | undefined {
    let pending: Promise<void> | undefined;
    for (const byte of bytes) {
      this.#buffer[this.#bufferLength] = byte;
      this.#bufferLength += 1;
      this.#length += 1;
      if (this.#bufferLength === partSize) {
        const fullPart = this.#buffer;
        this.#buffer = new Uint8Array(partSize);
        this.#bufferLength = 0;
        pending = this.#uploadPart(fullPart);
      }
    }
    return pending;
  }

  async #uploadPart(bytes: Uint8Array): Promise<void> {
    await Promise.all([this.#sha1Writer.write(bytes), this.#sha512Writer.write(bytes)]);
    const part = await this.#upload.uploadPart(this.#parts.length + 1, bytes);
    this.#parts.push(part);
  }

  #assertFinished(): void {
    if (!this.#finished) throw new Error("tarball upload is not finished");
  }
}

class PublishJsonScanner {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #encoder = new TextEncoder();
  readonly #bucket: R2Bucket;
  readonly #packageName: string;
  readonly #frames: Frame[] = [];
  readonly #metadataParts: string[] = [];
  #metadataPending = "";
  #metadataBytes = 0;
  #rootState: "value" | "done" = "value";
  #mode: "default" | "string" | "primitive" = "default";
  #stringRole: "key" | "value" = "value";
  #stringRaw = "";
  #stringPath: JsonPathPart[] = [];
  #stringIsAttachment = false;
  #escapeState: "none" | "escaped" | "unicode" = "none";
  #unicodeEscape = "";
  #primitive = "";
  #attachment?: MultipartTarball;
  #attachmentText = "";

  constructor(bucket: R2Bucket, packageName: string) {
    this.#bucket = bucket;
    this.#packageName = packageName;
  }

  async write(bytes: Uint8Array): Promise<void> {
    let text: string;
    try {
      text = this.#decoder.decode(bytes, { stream: true });
    } catch {
      throw badJson("request body must be valid UTF-8 JSON");
    }
    await this.#consume(text);
    this.#flushMetadata();
  }

  async finish(): Promise<ParsedPublishRequest> {
    let tail: string;
    try {
      tail = this.#decoder.decode();
    } catch {
      throw badJson("request body must be valid UTF-8 JSON");
    }
    await this.#consume(tail);
    if (this.#mode === "primitive") this.#finishPrimitive();
    if (this.#mode !== "default" || this.#frames.length !== 0 || this.#rootState !== "done") {
      throw badJson();
    }
    this.#flushMetadata();
    await this.#flushAttachmentText();
    const attachment = this.#attachment;
    if (attachment === undefined) {
      throw new PublishStreamError(
        400,
        "bad_request",
        "publish must contain one tarball attachment",
      );
    }
    await attachment.finishBase64();

    let document: unknown;
    try {
      document = JSON.parse(this.#metadataParts.join("")) as unknown;
    } catch {
      throw badJson();
    }
    return { document, tarball: attachment };
  }

  async abort(): Promise<void> {
    await this.#attachment?.abort();
  }

  async #consume(text: string): Promise<void> {
    for (const character of text) {
      let pending: Promise<void> | undefined;
      if (this.#mode === "string") {
        pending = this.#consumeString(character);
      } else if (this.#mode === "primitive") {
        pending = this.#consumePrimitive(character);
      } else {
        pending = this.#consumeDefault(character);
      }
      if (pending !== undefined) await pending;
    }
  }

  #consumeDefault(character: string): Promise<void> | undefined {
    if (/\s/.test(character)) {
      this.#appendMetadata(character);
      return undefined;
    }

    if (character === '"') {
      const frame = this.#frames.at(-1);
      const isKey =
        frame?.type === "object" && (frame.state === "keyOrEnd" || frame.state === "key");
      if (!isKey && !this.#expectsValue()) throw badJson();
      this.#mode = "string";
      this.#stringRole = isKey ? "key" : "value";
      this.#stringPath = isKey ? [] : this.#currentValuePath();
      this.#stringIsAttachment = this.#isAttachmentPath(this.#stringPath);
      this.#stringRaw = '"';
      this.#escapeState = "none";
      this.#unicodeEscape = "";
      this.#appendMetadata('"');
      if (this.#stringIsAttachment) {
        if (this.#attachment !== undefined) {
          throw new PublishStreamError(
            400,
            "bad_request",
            "publish must contain exactly one tarball attachment",
          );
        }
        const filename = this.#stringPath[1];
        if (typeof filename !== "string") throw badJson();
        return MultipartTarball.create(this.#bucket, this.#packageName, filename).then(
          (attachment) => {
            this.#attachment = attachment;
          },
        );
      }
      return undefined;
    }

    if (character === "{" || character === "[") {
      if (!this.#expectsValue()) throw badJson();
      if (this.#frames.length >= maximumDepth) {
        throw new PublishStreamError(400, "bad_request", "JSON nesting exceeds 128 levels");
      }
      const path = this.#currentValuePath();
      this.#appendMetadata(character);
      this.#frames.push(
        character === "{"
          ? { type: "object", path, state: "keyOrEnd", keys: new Set() }
          : { type: "array", path, state: "valueOrEnd", index: 0 },
      );
      return undefined;
    }

    if (character === "}" || character === "]") {
      const frame = this.#frames.at(-1);
      const valid =
        character === "}"
          ? frame?.type === "object" && (frame.state === "keyOrEnd" || frame.state === "commaOrEnd")
          : frame?.type === "array" &&
            (frame.state === "valueOrEnd" || frame.state === "commaOrEnd");
      if (!valid) throw badJson();
      this.#appendMetadata(character);
      this.#frames.pop();
      this.#completeValue();
      return undefined;
    }

    if (character === ":") {
      const frame = this.#frames.at(-1);
      if (frame?.type !== "object" || frame.state !== "colon") throw badJson();
      frame.state = "value";
      this.#appendMetadata(character);
      return undefined;
    }

    if (character === ",") {
      const frame = this.#frames.at(-1);
      if (frame?.state !== "commaOrEnd") throw badJson();
      if (frame.type === "object") {
        frame.state = "key";
        delete frame.currentKey;
      } else {
        frame.state = "value";
        frame.index += 1;
      }
      this.#appendMetadata(character);
      return undefined;
    }

    if (this.#expectsValue() && /[-0-9tfn]/.test(character)) {
      this.#mode = "primitive";
      this.#primitive = character;
      this.#appendMetadata(character);
      return undefined;
    }
    throw badJson();
  }

  #consumeString(character: string): Promise<void> | undefined {
    if (this.#escapeState === "unicode") {
      if (!/[0-9a-f]/i.test(character)) throw badJson();
      this.#unicodeEscape += character;
      if (!this.#stringIsAttachment) this.#appendStringRaw(character);
      if (this.#unicodeEscape.length === 4) {
        if (this.#stringIsAttachment) {
          const pending = this.#appendAttachmentCharacter(
            String.fromCharCode(Number.parseInt(this.#unicodeEscape, 16)),
          );
          this.#escapeState = "none";
          return pending;
        }
        this.#escapeState = "none";
      }
      return undefined;
    }

    if (this.#escapeState === "escaped") {
      if (character === "u") {
        if (!this.#stringIsAttachment) this.#appendStringRaw(character);
        this.#unicodeEscape = "";
        this.#escapeState = "unicode";
        return undefined;
      }
      const escapedCharacters: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      const decoded = escapedCharacters[character];
      if (decoded === undefined) throw badJson();
      this.#escapeState = "none";
      if (this.#stringIsAttachment) return this.#appendAttachmentCharacter(decoded);
      this.#appendStringRaw(character);
      return undefined;
    }

    if (character === "\\") {
      if (!this.#stringIsAttachment) this.#appendStringRaw(character);
      this.#escapeState = "escaped";
      return undefined;
    }
    if (character === '"') {
      const pending = this.#flushAttachmentText();
      this.#appendMetadata('"');
      if (this.#stringRole === "key") this.#finishKey();
      else this.#completeValue();
      this.#mode = "default";
      return pending;
    }
    if (character.charCodeAt(0) < 0x20) throw badJson();
    if (this.#stringIsAttachment) return this.#appendAttachmentCharacter(character);
    this.#appendStringRaw(character);
    return undefined;
  }

  #consumePrimitive(character: string): Promise<void> | undefined {
    if (/\s/.test(character) || character === "," || character === "}" || character === "]") {
      this.#finishPrimitive();
      return this.#consumeDefault(character);
    }
    if (character === ":" || character === "{" || character === "[" || character === '"') {
      throw badJson();
    }
    this.#primitive += character;
    this.#appendMetadata(character);
    return undefined;
  }

  #finishPrimitive(): void {
    try {
      const parsed = JSON.parse(this.#primitive) as unknown;
      if (typeof parsed !== "number" && typeof parsed !== "boolean" && parsed !== null)
        throw badJson();
    } catch {
      throw badJson();
    }
    this.#primitive = "";
    this.#mode = "default";
    this.#completeValue();
  }

  #finishKey(): void {
    const frame = this.#frames.at(-1);
    if (frame?.type !== "object") throw badJson();
    let key: string;
    try {
      key = JSON.parse(`${this.#stringRaw}"`) as string;
    } catch {
      throw badJson();
    }
    if (frame.keys.has(key)) {
      throw new PublishStreamError(400, "bad_request", `duplicate JSON key: ${key}`);
    }
    frame.keys.add(key);
    frame.currentKey = key;
    frame.state = "colon";
  }

  #expectsValue(): boolean {
    const frame = this.#frames.at(-1);
    if (frame === undefined) return this.#rootState === "value";
    return frame.type === "object"
      ? frame.state === "value"
      : frame.state === "valueOrEnd" || frame.state === "value";
  }

  #currentValuePath(): JsonPathPart[] {
    const frame = this.#frames.at(-1);
    if (frame === undefined) return [];
    if (frame.type === "array") return [...frame.path, frame.index];
    if (frame.currentKey === undefined) throw badJson();
    return [...frame.path, frame.currentKey];
  }

  #completeValue(): void {
    const frame = this.#frames.at(-1);
    if (frame === undefined) {
      if (this.#rootState !== "value") throw badJson();
      this.#rootState = "done";
      return;
    }
    if (frame.type === "object") {
      if (frame.state !== "value") throw badJson();
      frame.state = "commaOrEnd";
    } else {
      if (frame.state !== "value" && frame.state !== "valueOrEnd") throw badJson();
      frame.state = "commaOrEnd";
    }
  }

  #isAttachmentPath(path: readonly JsonPathPart[]): boolean {
    return (
      path.length === 3 &&
      path[0] === "_attachments" &&
      typeof path[1] === "string" &&
      path[2] === "data"
    );
  }

  #appendStringRaw(character: string): void {
    if (this.#stringRole === "key") this.#stringRaw += character;
    this.#appendMetadata(character);
  }

  #appendAttachmentCharacter(character: string): Promise<void> | undefined {
    if (character.length !== 1 || character.charCodeAt(0) > 0x7f) {
      throw new PublishStreamError(400, "bad_request", "tarball attachment is not valid base64");
    }
    this.#attachmentText += character;
    if (this.#attachmentText.length >= 8192) return this.#flushAttachmentText();
    return undefined;
  }

  #flushAttachmentText(): Promise<void> | undefined {
    if (this.#attachmentText === "") return undefined;
    const value = this.#attachmentText;
    this.#attachmentText = "";
    return this.#attachment?.writeBase64(value);
  }

  #appendMetadata(value: string): void {
    this.#metadataPending += value;
    if (this.#metadataPending.length >= 8192) this.#flushMetadata();
  }

  #flushMetadata(): void {
    if (this.#metadataPending === "") return;
    this.#metadataBytes += this.#encoder.encode(this.#metadataPending).byteLength;
    if (this.#metadataBytes > metadataLimit) {
      throw new PublishStreamError(413, "payload_too_large", "publish metadata exceeds 1 MiB");
    }
    this.#metadataParts.push(this.#metadataPending);
    this.#metadataPending = "";
  }
}

export async function parsePublishRequest(
  request: Request,
  bucket: R2Bucket,
  packageName: string,
): Promise<ParsedPublishRequest> {
  if (request.body === null) throw badJson();
  const scanner = new PublishJsonScanner(bucket, packageName);
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await scanner.write(value);
    }
    return await scanner.finish();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await scanner.abort().catch(() => undefined);
    if (error instanceof PublishStreamError) throw error;
    throw error;
  } finally {
    reader.releaseLock();
  }
}
