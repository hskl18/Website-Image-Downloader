import { NextRequest } from "next/server";
import JSZip from "jszip";
import type { Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "../app/api/download-images/route";
import {
  assertSafeUrl,
  createPinnedLookup,
  getFinalUrl,
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

  it("rejects a request body larger than the input limit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new NextRequest("http://localhost/api/download-images", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "4097",
      },
      body: JSON.stringify({ url: "https://8.8.8.8/" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and non-string URLs as client errors", async () => {
    const malformed = new NextRequest("http://localhost/api/download-images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const nonString = new NextRequest("http://localhost/api/download-images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: { hostname: "8.8.8.8" } }),
    });

    await expect(POST(malformed)).resolves.toMatchObject({ status: 400 });
    await expect(POST(nonString)).resolves.toMatchObject({ status: 400 });
  });

  it.each([
    ["IPv4 loopback", "http://127.0.0.1/internal"],
    ["localhost", "http://localhost/internal"],
    ["IPv6 loopback", "http://[::1]/internal"],
    ["private network", "http://10.0.0.1/internal"],
    ["cloud metadata IP", "http://169.254.169.254/latest/meta-data"],
    ["IPv4 6a44 relay", "https://192.88.99.2/internal"],
    ["IPv6 NAT64", "https://[64:ff9b::7f00:1]/internal"],
    ["IPv6 local NAT64", "https://[64:ff9b:1::1]/internal"],
    ["IPv6 discard-only", "https://[100::1]/internal"],
    ["IPv6 IETF assignment", "https://[2001::1]/internal"],
    ["IPv6 6to4", "https://[2002:7f00:1::]/internal"],
    [
      "cloud metadata hostname",
      "http://metadata.google.internal/computeMetadata/v1",
    ],
  ])("blocks %s before making an outbound request", async (_, url) => {
    const fetchMock = vi.fn(async () => new Response("<html></html>"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(createDownloadRequest(url));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
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

  it("records the final public URL after validated redirects", async () => {
    const close = vi.fn(async () => undefined);
    const dispatcher = {} as Dispatcher;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://1.1.1.1/gallery/" },
        }),
      )
      .mockResolvedValueOnce(new Response("<html></html>"));

    const response = await safeFetch("https://8.8.8.8/start", {}, {
      fetchImpl,
      connectionFactory: () => ({ dispatcher, close }),
    });

    expect(getFinalUrl(response).href).toBe("https://1.1.1.1/gallery/");
    await response.text();
  });

  it("resolves relative images against the final validated page URL", async () => {
    const imageBytes = new Uint8Array(1_001);
    imageBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://1.1.1.1/gallery/" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<img src="photo.png">', {
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(imageBytes, {
          headers: { "content-type": "image/png" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      createDownloadRequest("https://8.8.8.8/start"),
    );

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      "https://1.1.1.1/gallery/photo.png",
    );
    expect(response.headers.get("content-disposition")).toContain("1.1.1.1");
  });

  it("preserves caller cancellation while applying the request timeout", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    const dispatcher = {} as Dispatcher;
    const fetchImpl = vi.fn(
      async (_input: URL | string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    const operation = safeFetch(
      "https://8.8.8.8/image.png",
      { signal: controller.signal },
      {
        fetchImpl,
        connectionFactory: () => ({ dispatcher, close }),
      },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort(new Error("job cancelled"));

    await expect(operation).rejects.toThrow("job cancelled");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an oversized webpage before buffering the body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html></html>", {
        headers: {
          "content-length": String(2 * 1024 * 1024 + 1),
          "content-type": "text/html",
        },
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

  it("rejects an explicit non-HTML page response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      createDownloadRequest("https://8.8.8.8/document"),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "URL did not return an HTML page",
    });
  });

  it("bounds concurrent image downloads", async () => {
    const imageUrls = Array.from(
      { length: 8 },
      (_, index) => `https://8.8.4.4/image-${index}.png`,
    );
    const html = imageUrls.map((url) => `<img src="${url}">`).join("");
    const imageBytes = new Uint8Array(1_001);
    imageBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let activeDownloads = 0;
    let maxActiveDownloads = 0;

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes("8.8.8.8")) {
        return new Response(html, { headers: { "content-type": "text/html" } });
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

  it("names archived files from detected bytes instead of remote extensions", async () => {
    const imageBytes = new Uint8Array(1_001);
    imageBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes("8.8.8.8")) {
        return new Response('<img src="https://8.8.4.4/photo.svg">', {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(imageBytes, {
        headers: { "content-type": "image/svg+xml" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      createDownloadRequest("https://8.8.8.8/images"),
    );
    const archive = await JSZip.loadAsync(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(Object.keys(archive.files)).toEqual(["photo.png"]);
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
          (error: Error | null, address: string | Array<{ address: string }>) => {
          if (error) reject(error);
          else resolve(String(address));
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

  it("returns the pinned address shape requested by Undici", async () => {
    const lookup = createPinnedLookup({ address: "8.8.8.8", family: 4 });
    const addresses = await new Promise<
      Array<{ address: string; family: number }>
    >((resolve, reject) => {
      lookup("public.example", { all: true }, (error, result) => {
        if (error) reject(error);
        else resolve(result as Array<{ address: string; family: number }>);
      });
    });

    expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
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
      resolve(
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        }),
      );
    }
    await expect(firstJob).resolves.toMatchObject({ status: 404 });
    await expect(secondJob).resolves.toMatchObject({ status: 404 });
  });

  it("keeps the job slot until every started image download settles", async () => {
    let resolvePendingImage: ((response: Response) => void) | undefined;
    let resolveSecondPage: ((response: Response) => void) | undefined;
    const pendingImage = new Promise<Response>((resolve) => {
      resolvePendingImage = resolve;
    });
    const secondPage = new Promise<Response>((resolve) => {
      resolveSecondPage = resolve;
    });
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/first")) {
        return new Response(
          '<img src="https://8.8.4.4/fatal.png"><img src="https://1.1.1.1/pending.png">',
          { headers: { "content-type": "text/html" } },
        );
      }
      if (requestUrl.includes("fatal.png")) {
        return new Response(null, {
          headers: { "content-length": String(8 * 1024 * 1024 + 1) },
        });
      }
      if (requestUrl.includes("pending.png")) return pendingImage;
      if (requestUrl.endsWith("/second")) return secondPage;
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstJob = POST(createDownloadRequest("https://8.8.8.8/first"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const secondJob = POST(createDownloadRequest("https://9.9.9.9/second"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    const thirdJob = await POST(
      createDownloadRequest("https://1.0.0.1/third"),
    );
    expect(thirdJob.status).toBe(429);

    resolvePendingImage?.(new Response("not an image"));
    resolveSecondPage?.(
      new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(firstJob).resolves.toMatchObject({ status: 413 });
    await expect(secondJob).resolves.toMatchObject({ status: 404 });
  });
});
