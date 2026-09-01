function isAlphabet(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

export function validateStrictBase64Syntax(value: string): void {
  if (value.length === 0 || value.length % 4 !== 0) throw new Error("invalid base64 payload");
  let bodyLength = value.length;
  if (value.endsWith("==")) bodyLength -= 2;
  else if (value.endsWith("=")) bodyLength -= 1;
  for (let index = 0; index < bodyLength; index += 1) {
    if (!isAlphabet(value.charCodeAt(index))) throw new Error("invalid base64 payload");
  }
  for (let index = bodyLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) throw new Error("invalid base64 payload");
  }
}

export function decodeStrictBase64(
  value: string,
  decode: (encoded: string) => Uint8Array = (encoded) => Buffer.from(encoded, "base64"),
): Buffer {
  validateStrictBase64Syntax(value);
  const bytes = Buffer.from(decode(value));
  if (bytes.toString("base64") !== value) throw new Error("invalid base64 payload");
  return bytes;
}
