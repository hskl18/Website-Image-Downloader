import { describe, expect, it } from "vitest";

import { detectImageFormat } from "../lib/server/image-format";

describe("image format detection", () => {
  it.each([
    ["JPEG", [0xff, 0xd8, 0xff, 0x00], "jpg"],
    ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "png"],
    ["GIF", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "gif"],
    [
      "WebP",
      [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
      "webp",
    ],
  ])("detects %s by bytes", (_, bytes, extension) => {
    expect(detectImageFormat(new Uint8Array(bytes))).toEqual({ extension });
  });

  it("does not treat an arbitrary RIFF file as WebP", () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]);

    expect(detectImageFormat(wav)).toBeNull();
  });

  it("does not treat an arbitrary BM prefix as a validated image", () => {
    expect(detectImageFormat(new Uint8Array([0x42, 0x4d, 0, 0]))).toBeNull();
  });
});
