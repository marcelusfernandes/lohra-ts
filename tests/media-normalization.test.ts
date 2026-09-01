import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_DATA_URI_BASE64_CHARS,
  MAX_HTTP_URL_CHARS,
  MAX_VISION_IMAGE_BYTES,
  buildImagePart,
  coerceImageCount,
  coerceImagePrompt,
  pythonTruthy,
  textPart,
  validateRemoteImage,
} from "../src/media/index.js";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "lohra-media-normalize-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("media Python coercions", () => {
  it.each([undefined, null, "", 0, false, [], {}])("treats %j as Python-falsy", (value) => {
    expect(pythonTruthy(value)).toBe(false);
  });

  it.each([[1], { a: 1 }, " ", 1, true])("treats %j as Python-truthy", (value) => {
    expect(pythonTruthy(value)).toBe(true);
  });

  it("renders JSON values with Python str semantics", () => {
    expect(coerceImagePrompt(7)).toBe("7");
    expect(coerceImagePrompt(true)).toBe("True");
    expect(coerceImagePrompt([1, "x"])).toBe("[1, 'x']");
    expect(coerceImagePrompt({ a: 1 })).toBe("{'a': 1}");
    expect(() => coerceImagePrompt("   ")).toThrow("non-empty prompt");
  });

  it("implements int(), default and clamp semantics for n", () => {
    expect(coerceImageCount(undefined)).toBe(1);
    expect(coerceImageCount("2")).toBe(2);
    expect(coerceImageCount(1.9)).toBe(1);
    expect(coerceImageCount(true)).toBe(1);
    expect(coerceImageCount("1.9")).toBe(1);
    expect(coerceImageCount(0)).toBe(1);
    expect(coerceImageCount(50)).toBe(10);
  });
});

describe("vision image parts", () => {
  it("builds exact text and local image shapes", async () => {
    const directory = root();
    const png = join(directory, "one.png");
    const jpg = join(directory, "copy.jpg");
    const noExtension = join(directory, "raw");
    const svg = join(directory, "vector.svg");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(jpg, Buffer.from([1, 2, 3]));
    writeFileSync(noExtension, Buffer.from([4, 5]));
    writeFileSync(svg, "<svg/>");

    expect(textPart("x")).toEqual({ type: "text", text: "x" });
    await expect(buildImagePart({ path: png, localRoot: directory })).resolves.toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw==" },
    });
    await expect(buildImagePart({ path: jpg, localRoot: directory })).resolves.toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,AQID" },
    });
    await expect(buildImagePart({ path: noExtension, localRoot: directory })).resolves.toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,BAU=" },
    });
    await expect(buildImagePart({ path: svg, localRoot: directory })).resolves.toEqual({
      type: "image_url",
      image_url: { url: "data:image/svg+xml;base64,PHN2Zy8+" },
    });
  });

  it("rejects non-images, traversal and symlinks before read", async () => {
    const directory = root();
    const outside = root();
    const text = join(directory, "note.txt");
    const secret = join(outside, "secret.png");
    writeFileSync(text, "no");
    writeFileSync(secret, "secret");
    symlinkSync(secret, join(directory, "link.png"));

    await expect(buildImagePart({ path: text, localRoot: directory })).rejects.toThrow(
      "is not an image (text/plain)",
    );
    await expect(
      buildImagePart({ path: join(directory, "..", "escape.png"), localRoot: directory }),
    ).rejects.toThrow("outside localRoot");
    await expect(buildImagePart({ path: "link.png", localRoot: directory })).rejects.toThrow(
      "symlink",
    );
    await expect(buildImagePart({ path: "missing.png", localRoot: directory })).rejects.toThrow(
      "no such image file: missing.png",
    );
  });

  it("absorbs a trusted-root alias and accepts the measured large oracle fixture", async () => {
    const parent = root();
    const actual = join(parent, "actual");
    const alias = join(parent, "alias");
    mkdirSync(actual);
    const bytes = Buffer.alloc(1_048_585, 0x41);
    writeFileSync(join(actual, "large.png"), bytes);
    symlinkSync(actual, alias);
    const part = await buildImagePart({ path: join(alias, "large.png"), localRoot: alias });
    const encoded = part.image_url.url.slice(part.image_url.url.indexOf(",") + 1);
    expect(Buffer.from(encoded, "base64")).toEqual(bytes);
  });

  it("revalidates after the observable input preflight hook", async () => {
    const directory = root();
    const outside = root();
    const source = join(directory, "image.png");
    const target = join(outside, "secret.png");
    writeFileSync(source, "safe");
    writeFileSync(target, "secret");
    const hook = vi.fn(() => {
      rmSync(source);
      symlinkSync(target, source);
    });
    await expect(
      buildImagePart({ path: source, localRoot: directory, afterInputPreflight: hook }),
    ).rejects.toThrow("changed after preflight");
    expect(hook).toHaveBeenCalledOnce();
  });

  it("keeps the captured canonical root across an observable root swap", async () => {
    const parent = root();
    const directory = join(parent, "trusted");
    const moved = join(parent, "moved");
    const outside = root();
    const source = join(directory, "image.png");
    mkdirSync(directory);
    writeFileSync(source, "safe");
    writeFileSync(join(outside, "image.png"), "secret");
    await expect(
      buildImagePart({
        path: source,
        localRoot: directory,
        afterInputPreflight: () => {
          renameSync(directory, moved);
          symlinkSync(outside, directory);
        },
      }),
    ).rejects.toThrow("localRoot changed after preflight");
  });
});

describe("remote vision validation", () => {
  it("accepts bounded http(s) and valid data images verbatim", () => {
    const https = "https://example.test/a?sig=canary";
    const data = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
    expect(validateRemoteImage(https)).toBe(https);
    expect(validateRemoteImage(data)).toBe(data);
    expect(validateRemoteImage(`data:image/png;base64,${"A".repeat(131_072)}`)).toContain(
      "data:image/png;base64,",
    );
  });

  it("fails closed for credentials, unsafe hosts, schemes and invalid data", () => {
    expect(() => validateRemoteImage("file:///tmp/a.png")).toThrow("unsupported image URL");
    expect(() => validateRemoteImage("javascript:alert(1)")).toThrow("unsupported image URL");
    expect(() => validateRemoteImage("http://localhost/a")).toThrow("unsafe image host");
    expect(() => validateRemoteImage("http://127.0.0.1/a")).toThrow("unsafe image host");
    expect(() => validateRemoteImage("http://192.0.2.1/a")).toThrow("unsafe image host");
    expect(() => validateRemoteImage("http://[2001:db8::1]/a")).toThrow("unsafe image host");
    expect(() => validateRemoteImage("http://[::ffff:127.0.0.1]/a")).toThrow("unsafe image host");
    expect(() => validateRemoteImage("https://u:p@example.test/a")).toThrow("credentials");
    expect(() => validateRemoteImage("data:text/plain;base64,QQ==")).toThrow("image data URI");
    expect(() => validateRemoteImage("data:image/png;base64,%%%")).toThrow("base64");
    expect(() => validateRemoteImage("data:image/png;base64,AB==")).toThrow("base64");
  });

  it("validates large strict base64 iteratively", () => {
    const payload = "A".repeat(1_048_576);
    expect(validateRemoteImage(`data:image/png;base64,${payload}`)).toContain(
      "data:image/png;base64,",
    );
  });

  it("separates HTTP and encoded data URI limits before decode", () => {
    const prefix = "https://example.test/";
    const atHttpLimit = `${prefix}${"a".repeat(MAX_HTTP_URL_CHARS - prefix.length)}`;
    expect(validateRemoteImage(atHttpLimit)).toBe(atHttpLimit);
    expect(() => validateRemoteImage(`${atHttpLimit}a`)).toThrow("too long");
    const decode = vi.fn((value: string) => Buffer.from(value, "base64"));
    expect(() =>
      validateRemoteImage(`data:image/png;base64,${"A".repeat(MAX_DATA_URI_BASE64_CHARS + 4)}`, {
        decode,
      }),
    ).toThrow("too large");
    expect(decode).not.toHaveBeenCalled();
  });

  it("covers legal encoded and decoded 20 MiB boundaries", () => {
    const lower = "A".repeat(MAX_DATA_URI_BASE64_CHARS - 4);
    expect(validateRemoteImage(`data:image/png;base64,${lower}`).length).toBe(
      "data:image/png;base64,".length + lower.length,
    );
    const exact = Buffer.alloc(MAX_VISION_IMAGE_BYTES).toString("base64");
    expect(exact).toHaveLength(MAX_DATA_URI_BASE64_CHARS);
    expect(validateRemoteImage(`data:image/png;base64,${exact}`).length).toBe(
      "data:image/png;base64,".length + exact.length,
    );
    const decodedOverflow = Buffer.alloc(MAX_VISION_IMAGE_BYTES + 1).toString("base64");
    expect(decodedOverflow).toHaveLength(MAX_DATA_URI_BASE64_CHARS);
    expect(() => validateRemoteImage(`data:image/png;base64,${decodedOverflow}`)).toThrow("20 MiB");
  });
});
