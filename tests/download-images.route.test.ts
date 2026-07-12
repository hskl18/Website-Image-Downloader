import { NextRequest } from "next/server";
import type { Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "../app/api/download-images/route";
import {
  assertSafeUrl,
  createPinnedLookup,
  safeFetch,
} from "../lib/server/egress";

function createDownloadRequest(url: string) {
  return new NextRequest("http://localhost/api/download-images", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

describe("POST /api/download-images", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["IPv4 loopback", "http://127.0.0.1/internal"],
    ["localhost", "http://localhost/internal"],
    ["IPv6 loopback", "http://[::1]/internal"],
    ["private network", "http://10.0.0.1/internal"],
    ["cloud metadata IP", "http://169.254.169.254/latest/meta-data"],
    [
      "cloud metadata hostname",
      "http://metadata.google.internal/computeMetadata/v1",
    ],
  ])("blocks %s before making an outbound request", async (_, url) => {
    const fetchMock = vi.fn(async () => new Response("<html></html>"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(createDownloadRequest(url));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "URL is not allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a hostname when DNS resolves it to a private address", async () => {
    await expect(
      assertSafeUrl(
        new URL("https://attacker.example/images"),
        async () => [{ address: "127.0.0.1", family: 4 }],
      ),
    ).rejects.toThrow("URL is not allowed");
  });

  it("allows a hostname only when every DNS address is public", async () => {
    await expect(
      assertSafeUrl(
        new URL("https://public.example/images"),
        async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "1.1.1.1", family: 4 },
        ],
      ),
    ).resolves.toEqual({ address: "8.8.8.8", family: 4 });

    await expect(
      assertSafeUrl(
        new URL("https://mixed.example/images"),
        async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      ),
    ).rejects.toThrow("URL is not allowed");
  });

  it.each([
    ["a non-HTTP protocol", "ftp://8.8.8.8/image.jpg"],
    ["a non-standard HTTP port", "http://8.8.8.8:8080/images"],
    ["embedded credentials", "https://user:pass@8.8.8.8/images"],
  ])("blocks %s", async (_, url) => {
    const fetchMock = vi.fn(async () => new Response("<html></html>"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(createDownloadRequest(url));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "URL is not allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates a redirect target before following it", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      createDownloadRequest("https://8.8.8.8/images"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "URL is not allowed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized webpage before buffering the body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html></html>", {
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      createDownloadRequest("https://8.8.8.8/images"),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Download exceeds safety limits",
    });
  });

  it("bounds concurrent image downloads", async () => {
    const imageUrls = Array.from(
      { length: 8 },
      (_, index) => `https://8.8.4.4/image-${index}.png`,
    );
    const html = imageUrls.map((url) => `<img src="${url}">`).join("");
    const imageBytes = new Uint8Array(1_001);
    imageBytes.set([0x89, 0x50, 0x4e, 0x47]);
    let activeDownloads = 0;
    let maxActiveDownloads = 0;

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes("8.8.8.8")) {
        return new Response(html);
      }

      activeDownloads += 1;
      maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDownloads -= 1;
      return new Response(imageBytes, {
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      createDownloadRequest("https://8.8.8.8/images"),
    );

    expect(response.status).toBe(200);
    expect(maxActiveDownloads).toBeLessThanOrEqual(4);
  });

  it("pins the validated address into the connection lookup", async () => {
    let dnsAnswer = { address: "8.8.8.8", family: 4 as const };
    const resolver = vi.fn(async () => {
      const answer = dnsAnswer;
      dnsAnswer = { address: "127.0.0.1", family: 4 };
      return [answer];
    });
    const close = vi.fn(async () => undefined);
    const dispatcher = {} as Dispatcher;
    const connectionFactory = vi.fn((address) => ({
      dispatcher,
      close,
      lookup: createPinnedLookup(address),
    }));
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(String(_input)).toBe("https://rebind.example/image.png");
      expect(init.dispatcher).toBe(dispatcher);
      const connection = connectionFactory.mock.results[0].value;
      const connectedAddress = await new Promise<string>((resolve, reject) => {
        connection.lookup(
          "rebind.example",
          {},
          (error: Error | null, address: string) => {
          if (error) reject(error);
          else resolve(address);
          },
        );
      });
      expect(connectedAddress).toBe("8.8.8.8");
      expect(dnsAnswer.address).toBe("127.0.0.1");
      return new Response("ok");
    });

    const response = await safeFetch("https://rebind.example/image.png", {}, {
      resolver,
      fetchImpl,
      connectionFactory,
    });
    await response.text();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns 429 when the process download job limit is full", async () => {
    const pendingResponses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolve) => pendingResponses.push(resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const firstJob = POST(createDownloadRequest("https://8.8.8.8/first"));
    const secondJob = POST(createDownloadRequest("https://8.8.4.4/second"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const rejectedJob = await POST(
      createDownloadRequest("https://1.1.1.1/third"),
    );
    expect(rejectedJob.status).toBe(429);
    expect(rejectedJob.headers.get("retry-after")).toBe("5");

    for (const resolve of pendingResponses) {
      resolve(new Response("<html></html>"));
    }
    await expect(firstJob).resolves.toMatchObject({ status: 404 });
    await expect(secondJob).resolves.toMatchObject({ status: 404 });
  });
});
