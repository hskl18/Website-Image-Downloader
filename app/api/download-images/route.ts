import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import JSZip from "jszip";

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    // Validate URL
    let targetUrl: URL;
    try {
      targetUrl = new URL(url);
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    // Fetch the webpage
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch webpage" },
        { status: 400 }
      );
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract all image URLs
    const imageUrls = new Set<string>();

    // Find img tags
    $("img").each((_, element) => {
      const src = $(element).attr("src");
      const dataSrc = $(element).attr("data-src"); // lazy loading
      const srcset = $(element).attr("srcset");

      if (src) imageUrls.add(src);
      if (dataSrc) imageUrls.add(dataSrc);

      // Extract from srcset
      if (srcset) {
        const srcsetUrls = srcset.split(",").map((s) => s.trim().split(" ")[0]);
        srcsetUrls.forEach((url) => imageUrls.add(url));
      }
    });

    // Find favicons and icons
    $('link[rel*="icon"]').each((_, element) => {
      const href = $(element).attr("href");
      if (href) imageUrls.add(href);
    });

    // Find apple touch icons
    $('link[rel="apple-touch-icon"]').each((_, element) => {
      const href = $(element).attr("href");
      if (href) imageUrls.add(href);
    });

    // Find manifest icons
    const manifestLinks: string[] = [];
    $('link[rel="manifest"]').each((_, element) => {
      const href = $(element).attr("href");
      if (href) {
        manifestLinks.push(href);
      }
    });

    // Process manifest files
    for (const href of manifestLinks) {
      try {
        const manifestUrl = new URL(href, targetUrl).href;
        const manifestResponse = await fetch(manifestUrl);
        if (manifestResponse.ok) {
          const manifest = await manifestResponse.json();
          if (manifest.icons) {
            manifest.icons.forEach((icon: any) => {
              if (icon.src) imageUrls.add(icon.src);
            });
          }
        }
      } catch (e) {
        console.log("Failed to fetch manifest:", e);
      }
    }

    // Find CSS background images
    $("*").each((_, element) => {
      const style = $(element).attr("style");
      if (style) {
        const bgImageMatch = style.match(
          /background-image:\s*url\(['"]?([^'"]+)['"]?\)/
        );
        if (bgImageMatch && bgImageMatch[1]) {
          imageUrls.add(bgImageMatch[1]);
        }
      }
    });

    // Find SVG elements and convert to data URLs
    $("svg").each((_, element) => {
      try {
        const svgHtml = $.html(element);
        const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(
          svgHtml
        ).toString("base64")}`;
        imageUrls.add(svgDataUrl);
      } catch (e) {
        console.log("Failed to process SVG:", e);
      }
    });

    // Look for common logo patterns
    $('img[alt*="logo" i], img[class*="logo" i], img[id*="logo" i]').each(
      (_, element) => {
        const src = $(element).attr("src");
        if (src) imageUrls.add(src);
      }
    );

    // Convert relative URLs to absolute URLs
    const absoluteImageUrls = Array.from(imageUrls)
      .map((src) => {
        try {
          return new URL(src, targetUrl).href;
        } catch {
          return null;
        }
      })
      .filter((url): url is string => url !== null)
      .filter((url) => {
        // Filter for common image extensions or data URLs
        const imageExtensions =
          /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|tif|avif)(\?.*)?$/i;
        const isDataUrl = url.startsWith("data:image/");
        return imageExtensions.test(url) || isDataUrl;
      });

    if (absoluteImageUrls.length === 0) {
      return NextResponse.json(
        { error: "No images found on the webpage" },
        { status: 404 }
      );
    }

    // Create ZIP file with organized folders
    const zip = new JSZip();
    const imagesFolder = zip.folder("images");
    const iconsFolder = zip.folder("icons");
    const logosFolder = zip.folder("logos");
    const svgsFolder = zip.folder("svgs");

    // Download images and add to ZIP
    const downloadPromises = absoluteImageUrls.map(async (imageUrl, index) => {
      try {
        let imageBuffer: ArrayBuffer;
        let filename: string;
        let folder = imagesFolder;

        // Handle data URLs (inline SVGs)
        if (imageUrl.startsWith("data:image/")) {
          const base64Data = imageUrl.split(",")[1];
          imageBuffer = Buffer.from(base64Data, "base64").buffer;
          filename = `inline_svg_${index + 1}.svg`;
          folder = svgsFolder;
        } else {
          // Regular URL
          const imageResponse = await fetch(imageUrl, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
          });

          if (!imageResponse.ok) return;

          imageBuffer = await imageResponse.arrayBuffer();
          const urlObj = new URL(imageUrl);
          const pathname = urlObj.pathname;
          filename = pathname.split("/").pop() || `image_${index + 1}`;

          // Categorize images into folders
          if (
            imageUrl.includes("favicon") ||
            imageUrl.includes("icon") ||
            filename.includes("icon")
          ) {
            folder = iconsFolder;
          } else if (imageUrl.includes("logo") || filename.includes("logo")) {
            folder = logosFolder;
          } else if (imageUrl.endsWith(".svg") || filename.endsWith(".svg")) {
            folder = svgsFolder;
          }

          // Ensure filename has an extension
          if (!filename.includes(".")) {
            const contentType = imageResponse.headers.get("content-type");
            let extension = ".jpg"; // default
            if (contentType?.includes("png")) extension = ".png";
            else if (contentType?.includes("gif")) extension = ".gif";
            else if (contentType?.includes("webp")) extension = ".webp";
            else if (contentType?.includes("svg")) extension = ".svg";
            else if (contentType?.includes("icon")) extension = ".ico";
            else if (contentType?.includes("avif")) extension = ".avif";

            filename = `${filename}${extension}`;
          }
        }

        // Avoid duplicate filenames
        let finalFilename = filename;
        let counter = 1;
        while (folder?.file(finalFilename)) {
          const nameWithoutExt = filename.replace(/\.[^/.]+$/, "");
          const ext = filename.match(/\.[^/.]+$/)?.[0] || "";
          finalFilename = `${nameWithoutExt}_${counter}${ext}`;
          counter++;
        }

        folder?.file(finalFilename, imageBuffer);
      } catch (error) {
        console.error(`Failed to download image: ${imageUrl}`, error);
      }
    });

    await Promise.all(downloadPromises);

    // Generate ZIP file
    const zipBuffer = await zip.generateAsync({ type: "arraybuffer" });

    // Create filename from URL
    const hostname = targetUrl.hostname.replace(/^www\./, "");
    const sanitizedHostname = hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    const filename = `${sanitizedHostname}_images.zip`;

    // Return ZIP file
    return new NextResponse(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
