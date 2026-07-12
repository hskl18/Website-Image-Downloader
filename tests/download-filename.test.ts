import { describe, expect, it } from "vitest";

import { getDownloadFilename } from "../lib/client/download-filename";

describe("browser download filename", () => {
  it("uses the server filename derived from the final validated host", () => {
    const response = new Response(null, {
      headers: {
        "content-disposition": 'attachment; filename="final.example_images.zip"',
      },
    });

    expect(getDownloadFilename(response)).toBe("final.example_images.zip");
  });

  it("falls back when the response does not provide a safe filename", () => {
    expect(getDownloadFilename(new Response())).toBe("public-page-images.zip");
  });
});
