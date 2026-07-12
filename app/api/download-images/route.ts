import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import JSZip from "jszip";
import crypto from "crypto";
import { mapWithConcurrency } from "../../../lib/server/concurrency";
import { EgressPolicyError, safeFetch } from "../../../lib/server/egress";
import { JobLimiter } from "../../../lib/server/job-limit";
import {
  ByteBudget,
  readResponseBytes,
  ResponseLimitError,
} from "../../../lib/server/response-limits";

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_COUNT = 40;
const MAX_CONCURRENT_DOWNLOADS = 4;
const downloadJobLimiter = new JobLimiter(2);

// Simple image validation
function isValidImage(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;

  // Check common image signatures
  const signatures = [
    [0xff, 0xd8, 0xff], // JPEG
    [0x89, 0x50, 0x4e, 0x47], // PNG
    [0x47, 0x49, 0x46], // GIF
    [0x52, 0x49, 0x46, 0x46], // WebP (RIFF)
    [0x42, 0x4d], // BMP
  ];

  return signatures.some((sig) => sig.every((byte, i) => bytes[i] === byte));
}

// Get file extension from URL or content type
function getFileExtension(url: string, contentType?: string): string {
  const urlExt = url.match(/\.([a-z0-9]+)(\?|$)/i)?.[1]?.toLowerCase();
  if (urlExt && ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(urlExt)) {
    return urlExt === "jpeg" ? "jpg" : urlExt;
  }

  if (contentType?.includes("jpeg")) return "jpg";
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("gif")) return "gif";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("svg")) return "svg";

  return "jpg";
}

export async function POST(request: NextRequest) {
  const releaseJob = downloadJobLimiter.tryAcquire();
  if (!releaseJob) {
    return NextResponse.json(
      { error: "Too many download jobs are running" },
      { status: 429, headers: { "Retry-After": "5" } },
    );
  }

  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(url);
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    // Fetch webpage
    const response = await safeFetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      await response.body?.cancel();
      return NextResponse.json(
        { error: "Failed to fetch webpage" },
        { status: 400 }
      );
    }

    const htmlBytes = await readResponseBytes(response, MAX_PAGE_BYTES);
    const html = new TextDecoder().decode(htmlBytes);
    const $ = cheerio.load(html);
    const imageUrls = new Set<string>();

    // Extract images from various sources
    // 1. IMG tags
    $("img").each((_, el) => {
      const src =
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        $(el).attr("data-original");
      if (src) imageUrls.add(src);

      // Handle srcset
      const srcset = $(el).attr("srcset");
      if (srcset) {
        srcset.split(",").forEach((s) => {
          const url = s.trim().split(/\s+/)[0];
          if (url) imageUrls.add(url);
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
        if (bgMatch?.[1]) imageUrls.add(bgMatch[1]);
      }
    });

    // 3. Meta images (Open Graph, Twitter)
    $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
      const content = $(el).attr("content");
      if (content) imageUrls.add(content);
    });

    // 4. Favicons
    $('link[rel*="icon"]').each((_, el) => {
      const href = $(el).attr("href");
      if (href) imageUrls.add(href);
    });

    // Convert to absolute URLs and filter
    const validUrls: string[] = [];
    const seenUrls = new Set<string>();

    Array.from(imageUrls).forEach((src) => {
      try {
        const absoluteUrl = new URL(src, targetUrl).href;

        // Skip duplicates and bad URLs
        if (seenUrls.has(absoluteUrl)) return;
        if (
          absoluteUrl.includes("data:,") ||
          absoluteUrl.includes("1x1") ||
          absoluteUrl.includes("pixel")
        )
          return;

        // Must look like an image
        const hasImageExt =
          /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp|avif)(\?.*)?$/i.test(
            absoluteUrl
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
      return NextResponse.json({ error: "No images found" }, { status: 404 });
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
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Referer: targetUrl.href,
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
            .createHash("md5")
            .update(Buffer.from(bytes))
            .digest("hex");
          if (downloadedHashes.has(hash)) return;
          downloadedHashes.add(hash);

          // Validate it's actually an image
          if (!isValidImage(bytes)) return;

        // Generate filename
        const urlPath = new URL(imageUrl).pathname;
        let filename = urlPath.split("/").pop() || `image_${index + 1}`;

        // Ensure proper extension
        const ext = getFileExtension(
          imageUrl,
          imageResponse.headers.get("content-type") || undefined
        );
        if (!filename.includes(".")) {
          filename += `.${ext}`;
        }

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
      return NextResponse.json(
        { error: "No images could be downloaded" },
        { status: 404 }
      );
    }

    // Generate ZIP
    const zipBuffer = await zip.generateAsync({ type: "arraybuffer" });

    const hostname = targetUrl.hostname.replace(/^www\./, "");
    const filename = `${hostname.replace(/[^a-zA-Z0-9.-]/g, "_")}_images.zip`;

    return new NextResponse(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    if (error instanceof EgressPolicyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof ResponseLimitError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }

    console.error("Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  } finally {
    releaseJob();
  }
}
