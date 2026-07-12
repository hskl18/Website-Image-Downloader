import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import JSZip from "jszip";
import crypto from "crypto";
import { mapWithConcurrency } from "../../../lib/server/concurrency";
import {
  EgressPolicyError,
  getFinalUrl,
  safeFetch,
} from "../../../lib/server/egress";
import { JobLimiter } from "../../../lib/server/job-limit";
import { detectImageFormat } from "../../../lib/server/image-format";
import {
  ByteBudget,
  readResponseBytes,
  ResponseLimitError,
} from "../../../lib/server/response-limits";

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_URL_LENGTH = 2_048;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_COUNT = 40;
const MAX_DISCOVERED_URLS = 160;
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_JOB_MS = 30_000;
const downloadJobLimiter = new JobLimiter(2);

function errorResponse(
  error: string,
  status: number,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(
    { error },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      },
    },
  );
}

class RequestInputError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function parseTargetUrl(request: NextRequest) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new RequestInputError("Content-Type must be application/json", 415);
  }

  const requestHeaders = new Headers();
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) requestHeaders.set("content-length", declaredLength);
  const requestBytes = await readResponseBytes(
    new Response(request.body, { headers: requestHeaders }),
    MAX_REQUEST_BYTES,
  );
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(requestBytes));
  } catch {
    throw new RequestInputError("Invalid JSON body", 400);
  }
  const url =
    typeof body === "object" && body !== null && "url" in body
      ? (body as { url?: unknown }).url
      : undefined;

  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH) {
    throw new RequestInputError("URL is required", 400);
  }

  try {
    return new URL(url);
  } catch {
    throw new RequestInputError("Invalid URL", 400);
  }
}

export async function POST(request: NextRequest) {
  let targetUrl: URL;
  try {
    targetUrl = await parseTargetUrl(request);
  } catch (error) {
    if (error instanceof RequestInputError) {
      return errorResponse(error.message, error.status);
    }
    if (error instanceof ResponseLimitError) {
      return errorResponse(error.message, 413);
    }
    return errorResponse("Invalid request body", 400);
  }

  const releaseJob = downloadJobLimiter.tryAcquire();
  if (!releaseJob) {
    return errorResponse(
      "Too many download jobs are running",
      429,
      { "Retry-After": "5" },
    );
  }

  const jobSignal = AbortSignal.timeout(MAX_JOB_MS);
  try {
    // Fetch webpage
    const response = await safeFetch(targetUrl, {
      signal: jobSignal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      await response.body?.cancel();
      return errorResponse("Failed to fetch webpage", 400);
    }

    const pageMediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      pageMediaType &&
      pageMediaType !== "text/html" &&
      pageMediaType !== "application/xhtml+xml"
    ) {
      await response.body?.cancel();
      return errorResponse("URL did not return an HTML page", 415);
    }

    const htmlBytes = await readResponseBytes(response, MAX_PAGE_BYTES);
    const html = new TextDecoder().decode(htmlBytes);
    const finalPageUrl = getFinalUrl(response);
    const $ = cheerio.load(html);
    const imageUrls = new Set<string>();
    const addImageUrl = (candidate: string | undefined) => {
      if (candidate && imageUrls.size < MAX_DISCOVERED_URLS) {
        imageUrls.add(candidate);
      }
    };

    // Extract images from various sources
    // 1. IMG tags
    $("img").each((_, el) => {
      const src =
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        $(el).attr("data-original");
      addImageUrl(src);

      // Handle srcset
      const srcset = $(el).attr("srcset");
      if (srcset) {
        srcset.split(",").forEach((s) => {
          const url = s.trim().split(/\s+/)[0];
          addImageUrl(url);
        });
      }
    });

    // 2. CSS background images
    $("*").each((_, el) => {
      const style = $(el).attr("style");
      if (style) {
        const bgMatch = style.match(
          /background-image:\s*url\(['"]?([^'")\s]+)['"]?\)/i
        );
        addImageUrl(bgMatch?.[1]);
      }
    });

    // 3. Meta images (Open Graph, Twitter)
    $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
      const content = $(el).attr("content");
      addImageUrl(content);
    });

    // 4. Favicons
    $('link[rel*="icon"]').each((_, el) => {
      const href = $(el).attr("href");
      addImageUrl(href);
    });

    // Convert to absolute URLs and filter
    const validUrls: string[] = [];
    const seenUrls = new Set<string>();

    Array.from(imageUrls).forEach((src) => {
      try {
        const absoluteUrl = new URL(src, finalPageUrl).href;

        // Skip duplicates and bad URLs
        if (seenUrls.has(absoluteUrl)) return;
        if (
          absoluteUrl.includes("data:,") ||
          absoluteUrl.includes("1x1") ||
          absoluteUrl.includes("pixel")
        )
          return;

        // Must look like an image
        const hasImageExt = /\.(jpg|jpeg|png|gif|webp|bmp)(\?.*)?$/i.test(
          absoluteUrl,
        );
        const hasImageKeyword =
          /\b(image|img|photo|pic|thumb|avatar|logo|icon|banner)\b/i.test(
            absoluteUrl
          );

        if (hasImageExt || hasImageKeyword) {
          seenUrls.add(absoluteUrl);
          validUrls.push(absoluteUrl);
        }
      } catch {
        // Skip invalid URLs
      }
    });

    if (validUrls.length === 0) {
      return errorResponse("No images found", 404);
    }

    // Download images
    const zip = new JSZip();
    const downloadedHashes = new Set<string>();
    const byteBudget = new ByteBudget(MAX_TOTAL_IMAGE_BYTES);
    let successCount = 0;

    await mapWithConcurrency(
      validUrls.slice(0, MAX_IMAGE_COUNT),
      MAX_CONCURRENT_DOWNLOADS,
      async (imageUrl, index) => {
        try {
          const imageResponse = await safeFetch(imageUrl, {
            signal: jobSignal,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Referer: finalPageUrl.href,
            },
          });

          if (!imageResponse.ok) {
            await imageResponse.body?.cancel();
            return;
          }

          const bytes = await readResponseBytes(
            imageResponse,
            MAX_IMAGE_BYTES,
            byteBudget,
          );

          // Skip tiny images (likely tracking pixels)
          if (bytes.byteLength < 1000) return;

          // Skip duplicates
          const hash = crypto
            .createHash("sha256")
            .update(Buffer.from(bytes))
            .digest("hex");
          if (downloadedHashes.has(hash)) return;
          downloadedHashes.add(hash);

          const imageFormat = detectImageFormat(bytes);
          if (!imageFormat) return;

        // Generate filename
        const urlPath = new URL(imageUrl).pathname;
        let filename = urlPath.split("/").pop() || `image_${index + 1}`;

        const baseName = filename.replace(/\.[^.]*$/, "") || `image_${index + 1}`;
        filename = `${baseName}.${imageFormat.extension}`;

        // Sanitize filename
        filename = filename.replace(/[<>:"/\\|?*]/g, "_").substring(0, 100);

        // Avoid duplicates in zip
        let finalFilename = filename;
        let counter = 1;
        while (zip.file(finalFilename)) {
          const name = filename.replace(/\.[^.]+$/, "");
          const extension = filename.match(/\.[^.]+$/)?.[0] || "";
          finalFilename = `${name}_${counter}${extension}`;
          counter++;
        }

          zip.file(finalFilename, bytes);
          successCount++;
        } catch (error) {
          if (
            error instanceof EgressPolicyError ||
            error instanceof ResponseLimitError
          ) {
            throw error;
          }
        }
      },
    );

    if (successCount === 0) {
      return errorResponse("No images could be downloaded", 404);
    }

    // Generate ZIP
    const zipBuffer = await zip.generateAsync({ type: "arraybuffer" });

    const hostname = finalPageUrl.hostname.replace(/^www\./, "");
    const filename = `${hostname.replace(/[^a-zA-Z0-9.-]/g, "_")}_images.zip`;

    return new NextResponse(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof EgressPolicyError) {
      return errorResponse(error.message, 400);
    }

    if (error instanceof ResponseLimitError) {
      return errorResponse(error.message, 413);
    }

    if (error instanceof DOMException && error.name === "TimeoutError") {
      return errorResponse("Download job timed out", 504);
    }

    console.error("Error:", error);
    return errorResponse("Internal server error", 500);
  } finally {
    releaseJob();
  }
}
