import { NextRequest } from "next/server";
import * as cheerio from "cheerio";
import JSZip from "jszip";
import crypto from "crypto";

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const { url } = await request.json();

        if (!url) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: "URL is required" })}\n\n`
            )
          );
          controller.close();
          return;
        }

        // Send initial progress
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              progress: 0,
              stage: "Validating URL...",
              total: 0,
              completed: 0,
            })}\n\n`
          )
        );

        // Validate URL
        let targetUrl: URL;
        try {
          targetUrl = new URL(url);
        } catch {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: "Invalid URL" })}\n\n`
            )
          );
          controller.close();
          return;
        }

        // Fetch the webpage
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              progress: 5,
              stage: "Fetching webpage...",
              total: 0,
              completed: 0,
            })}\n\n`
          )
        );

        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });

        if (!response.ok) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: "Failed to fetch webpage",
              })}\n\n`
            )
          );
          controller.close();
          return;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              progress: 15,
              stage: "Analyzing webpage for images...",
              total: 0,
              completed: 0,
            })}\n\n`
          )
        );

        // Extract all image URLs with comprehensive detection
        const imageUrls = new Set<string>();

        // Find img tags with all possible attributes
        $("img").each((_, element) => {
          const attributes = [
            "src",
            "data-src",
            "data-original",
            "data-lazy",
            "data-srcset",
            "data-original-src",
            "data-lazy-src",
            "data-echo",
            "data-url",
            "data-hi-res-src",
            "data-low-res-src",
            "data-medium-res-src",
            "data-retina-src",
            "data-2x",
            "data-3x",
            "data-4x",
          ];

          attributes.forEach((attr) => {
            const value = $(element).attr(attr);
            if (value) imageUrls.add(value);
          });

          // Extract from srcset and data-srcset
          const srcsetAttrs = ["srcset", "data-srcset"];
          srcsetAttrs.forEach((attr) => {
            const srcset = $(element).attr(attr);
            if (srcset) {
              const srcsetUrls = srcset
                .split(",")
                .map((s) => s.trim().split(/\s+/)[0]);
              srcsetUrls.forEach((url) => imageUrls.add(url));
            }
          });
        });

        // Find favicons and icons
        const iconSelectors = [
          'link[rel="icon"]',
          'link[rel="shortcut icon"]',
          'link[rel="apple-touch-icon"]',
          'link[rel="apple-touch-icon-precomposed"]',
          'link[rel="mask-icon"]',
          'link[rel="fluid-icon"]',
          'link[type="image/x-icon"]',
          'link[type="image/vnd.microsoft.icon"]',
          'link[type="image/png"]',
          'link[type="image/gif"]',
          'link[type="image/jpeg"]',
          'link[type="image/svg+xml"]',
        ];

        iconSelectors.forEach((selector) => {
          $(selector).each((_, element) => {
            const href = $(element).attr("href");
            if (href) imageUrls.add(href);
          });
        });

        // Common favicon paths
        const commonFaviconPaths = [
          "/favicon.ico",
          "/favicon.png",
          "/favicon.gif",
          "/favicon.svg",
          "/apple-touch-icon.png",
          "/apple-touch-icon-precomposed.png",
          "/apple-icon.png",
          "/apple-icon-precomposed.png",
        ];
        commonFaviconPaths.forEach((path) => imageUrls.add(path));

        // Process manifest files
        const manifestLinks: string[] = [];
        $('link[rel="manifest"]').each((_, element) => {
          const href = $(element).attr("href");
          if (href) manifestLinks.push(href);
        });

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
            const imagePatterns = [
              /background-image:\s*url\(['"]?([^'")\s]+)['"]?\)/gi,
              /background:\s*url\(['"]?([^'")\s]+)['"]?\)/gi,
              /content:\s*url\(['"]?([^'")\s]+)['"]?\)/gi,
              /list-style-image:\s*url\(['"]?([^'")\s]+)['"]?\)/gi,
              /border-image:\s*url\(['"]?([^'")\s]+)['"]?\)/gi,
              /cursor:\s*url\(['"]?([^'")\s]+)['"]?\)/gi,
            ];

            imagePatterns.forEach((pattern) => {
              let match;
              while ((match = pattern.exec(style)) !== null) {
                if (match[1]) imageUrls.add(match[1]);
              }
            });
          }
        });

        // Parse CSS files
        const cssLinks: string[] = [];
        const styleElements: string[] = [];

        $('link[rel="stylesheet"]').each((_, element) => {
          const href = $(element).attr("href");
          if (href) cssLinks.push(href);
        });

        $("style").each((_, element) => {
          const content = $(element).html();
          if (content) styleElements.push(content);
        });

        for (const href of cssLinks) {
          try {
            const cssUrl = new URL(href, targetUrl).href;
            const cssResponse = await fetch(cssUrl);
            if (cssResponse.ok) {
              const cssContent = await cssResponse.text();
              const cssImagePattern = /url\(['"]?([^'")\s]+)['"]?\)/gi;
              let match;
              while ((match = cssImagePattern.exec(cssContent)) !== null) {
                if (
                  match[1] &&
                  /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|tif|avif)/i.test(
                    match[1]
                  )
                ) {
                  imageUrls.add(match[1]);
                }
              }
            }
          } catch (e) {
            console.log("Failed to parse CSS:", e);
          }
        }

        for (const cssContent of styleElements) {
          try {
            const cssImagePattern = /url\(['"]?([^'")\s]+)['"]?\)/gi;
            let match;
            while ((match = cssImagePattern.exec(cssContent)) !== null) {
              if (
                match[1] &&
                /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|tif|avif)/i.test(
                  match[1]
                )
              ) {
                imageUrls.add(match[1]);
              }
            }
          } catch (e) {
            console.log("Failed to parse inline CSS:", e);
          }
        }

        // Find SVG elements
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

        // Additional selectors
        const imageSelectors = [
          'img[alt*="logo" i], img[class*="logo" i], img[id*="logo" i]',
          'img[alt*="banner" i], img[class*="banner" i], img[id*="banner" i]',
          'img[alt*="hero" i], img[class*="hero" i], img[id*="hero" i]',
          'img[alt*="thumbnail" i], img[class*="thumbnail" i], img[id*="thumbnail" i]',
          'img[alt*="avatar" i], img[class*="avatar" i], img[id*="avatar" i]',
          'img[alt*="profile" i], img[class*="profile" i], img[id*="profile" i]',
          "picture img, figure img, .image img, .photo img, .picture img",
          '[style*="background-image"], [style*="background:"]',
          "video[poster]",
          "source[srcset]",
          'object[data*=".svg"], object[data*=".png"], object[data*=".jpg"], object[data*=".gif"]',
          'embed[src*=".svg"], embed[src*=".png"], embed[src*=".jpg"], embed[src*=".gif"]',
        ];

        imageSelectors.forEach((selector) => {
          $(selector).each((_, element) => {
            const tagName = (element as any).tagName?.toLowerCase();
            if (tagName === "video") {
              const poster = $(element).attr("poster");
              if (poster) imageUrls.add(poster);
            } else if (tagName === "source") {
              const srcset = $(element).attr("srcset");
              if (srcset) {
                const srcsetUrls = srcset
                  .split(",")
                  .map((s) => s.trim().split(/\s+/)[0]);
                srcsetUrls.forEach((url) => imageUrls.add(url));
              }
            } else if (tagName === "object" || tagName === "embed") {
              const data = $(element).attr("data") || $(element).attr("src");
              if (data) imageUrls.add(data);
            } else {
              const src = $(element).attr("src") || $(element).attr("data-src");
              if (src) imageUrls.add(src);
            }
          });
        });

        // Meta images
        const metaImageSelectors = [
          'meta[property="og:image"]',
          'meta[property="og:image:url"]',
          'meta[property="og:image:secure_url"]',
          'meta[name="twitter:image"]',
          'meta[name="twitter:image:src"]',
          'meta[property="twitter:image"]',
          'meta[name="thumbnail"]',
          'meta[property="article:image"]',
        ];

        metaImageSelectors.forEach((selector) => {
          $(selector).each((_, element) => {
            const content = $(element).attr("content");
            if (content) imageUrls.add(content);
          });
        });

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              progress: 25,
              stage: "Processing and filtering images...",
              total: 0,
              completed: 0,
            })}\n\n`
          )
        );

        // Convert to absolute URLs and deduplicate
        const processedUrls = new Map<string, string>();

        Array.from(imageUrls).forEach((src) => {
          try {
            const absoluteUrl = new URL(src, targetUrl).href;
            const imageExtensions =
              /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|tif|avif|jfif|pjpeg|pjp)(\?.*)?$/i;
            const isDataUrl = absoluteUrl.startsWith("data:image/");
            const mightBeImage =
              imageExtensions.test(absoluteUrl) ||
              isDataUrl ||
              absoluteUrl.includes("image") ||
              absoluteUrl.includes("img") ||
              absoluteUrl.includes("photo") ||
              absoluteUrl.includes("pic");

            if (mightBeImage) {
              const normalizedUrl = absoluteUrl
                .split("?")[0]
                .split("#")[0]
                .toLowerCase();
              const urlHash = crypto
                .createHash("md5")
                .update(normalizedUrl)
                .digest("hex");
              if (!processedUrls.has(urlHash)) {
                processedUrls.set(urlHash, absoluteUrl);
              }
            }
          } catch (error) {
            console.log(`Invalid URL: ${src}`);
          }
        });

        const absoluteImageUrls = Array.from(processedUrls.values());

        if (absoluteImageUrls.length === 0) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: "No images found on the webpage",
              })}\n\n`
            )
          );
          controller.close();
          return;
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              progress: 30,
              stage: `Found ${absoluteImageUrls.length} images. Starting downloads...`,
              total: absoluteImageUrls.length,
              completed: 0,
            })}\n\n`
          )
        );

        // Create ZIP
        const zip = new JSZip();
        const imagesFolder = zip.folder("images");
        const iconsFolder = zip.folder("icons");
        const logosFolder = zip.folder("logos");
        const svgsFolder = zip.folder("svgs");

        const downloadedHashes = new Set<string>();
        let completed = 0;

        // Download images with progress updates
        for (let index = 0; index < absoluteImageUrls.length; index++) {
          const imageUrl = absoluteImageUrls[index];

          try {
            let imageBuffer: ArrayBuffer;
            let filename: string;
            let folder = imagesFolder;

            if (imageUrl.startsWith("data:image/")) {
              const mimeMatch = imageUrl.match(/data:image\/([^;]+)/);
              const mimeType = mimeMatch ? mimeMatch[1] : "svg";
              const base64Data = imageUrl.split(",")[1];
              imageBuffer = Buffer.from(base64Data, "base64").buffer;
              filename = `inline_${mimeType}_${index + 1}.${mimeType}`;
              folder = mimeType === "svg" ? svgsFolder : imagesFolder;
            } else {
              const controller_fetch = new AbortController();
              const timeoutId = setTimeout(
                () => controller_fetch.abort(),
                10000
              );

              const imageResponse = await fetch(imageUrl, {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                  Accept:
                    "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                  "Accept-Language": "en-US,en;q=0.9",
                  "Accept-Encoding": "gzip, deflate, br",
                  "Cache-Control": "no-cache",
                  "Sec-Fetch-Dest": "image",
                  "Sec-Fetch-Mode": "no-cors",
                  "Sec-Fetch-Site": "cross-site",
                  Referer: targetUrl.href,
                },
                signal: controller_fetch.signal,
              });

              clearTimeout(timeoutId);

              if (!imageResponse.ok) {
                console.log(
                  `Failed to fetch ${imageUrl}: ${imageResponse.status}`
                );
                completed++;
                continue;
              }

              imageBuffer = await imageResponse.arrayBuffer();

              // Check for duplicates
              const contentHash = crypto
                .createHash("md5")
                .update(Buffer.from(imageBuffer))
                .digest("hex");
              if (downloadedHashes.has(contentHash)) {
                console.log(`Skipping duplicate image: ${imageUrl}`);
                completed++;
                continue;
              }
              downloadedHashes.add(contentHash);

              const urlObj = new URL(imageUrl);
              const pathname = urlObj.pathname;
              filename = pathname.split("/").pop() || `image_${index + 1}`;

              // Categorize images
              const lowerUrl = imageUrl.toLowerCase();
              const lowerFilename = filename.toLowerCase();

              const isIcon =
                lowerUrl.includes("favicon") ||
                lowerUrl.includes("icon") ||
                lowerUrl.includes("apple-touch") ||
                lowerUrl.includes("apple-icon") ||
                lowerUrl.includes("mask-icon") ||
                lowerUrl.includes("fluid-icon") ||
                lowerFilename.includes("favicon") ||
                lowerFilename.includes("icon") ||
                pathname === "/favicon.ico" ||
                pathname === "/favicon.png" ||
                pathname === "/favicon.gif" ||
                pathname === "/favicon.svg" ||
                lowerUrl.includes("shortcut") ||
                lowerUrl.includes("manifest");

              const isLogo =
                lowerUrl.includes("logo") ||
                lowerFilename.includes("logo") ||
                lowerUrl.includes("brand") ||
                lowerFilename.includes("brand");

              const isSvg =
                lowerUrl.includes(".svg") ||
                lowerFilename.includes(".svg") ||
                imageResponse.headers.get("content-type")?.includes("svg");

              const isBanner =
                lowerUrl.includes("banner") ||
                lowerFilename.includes("banner") ||
                lowerUrl.includes("hero") ||
                lowerFilename.includes("hero");

              if (isIcon) {
                folder = iconsFolder;
              } else if (isLogo) {
                folder = logosFolder;
              } else if (isSvg) {
                folder = svgsFolder;
              } else if (isBanner) {
                folder = zip.folder("banners");
              }

              // Determine extension
              if (!filename.includes(".") || filename.endsWith("/")) {
                const contentType = imageResponse.headers.get("content-type");
                let extension = ".jpg";

                if (contentType) {
                  if (contentType.includes("png")) extension = ".png";
                  else if (contentType.includes("gif")) extension = ".gif";
                  else if (contentType.includes("webp")) extension = ".webp";
                  else if (contentType.includes("svg")) extension = ".svg";
                  else if (
                    contentType.includes("icon") ||
                    contentType.includes("x-icon")
                  )
                    extension = ".ico";
                  else if (contentType.includes("avif")) extension = ".avif";
                  else if (contentType.includes("bmp")) extension = ".bmp";
                  else if (contentType.includes("tiff")) extension = ".tiff";
                  else if (contentType.includes("jpeg")) extension = ".jpg";
                } else {
                  const urlExt = imageUrl.match(
                    /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|tif|avif|jfif|pjpeg|pjp)(\?|#|$)/i
                  );
                  if (urlExt) extension = `.${urlExt[1].toLowerCase()}`;
                }

                filename = filename.replace(/\/$/, "") || `image_${index + 1}`;
                filename = `${filename}${extension}`;
              }
            }

            // Sanitize filename
            filename = filename
              .replace(/[<>:"/\\|?*]/g, "_")
              .replace(/\s+/g, "_");

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
            completed++;

            // Send progress update
            const progress =
              30 + Math.round((completed / absoluteImageUrls.length) * 60);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  progress,
                  stage: `Downloaded ${completed}/${absoluteImageUrls.length} images...`,
                  total: absoluteImageUrls.length,
                  completed,
                  currentFile: finalFilename,
                })}\n\n`
              )
            );
          } catch (error) {
            console.error(`Failed to download image: ${imageUrl}`, error);
            completed++;
          }
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              progress: 95,
              stage: "Creating ZIP file...",
              total: absoluteImageUrls.length,
              completed,
            })}\n\n`
          )
        );

        // Generate ZIP
        const zipBuffer = await zip.generateAsync({ type: "arraybuffer" });

        // Create filename
        const hostname = targetUrl.hostname.replace(/^www\./, "");
        const sanitizedHostname = hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
        const filename = `${sanitizedHostname}_images.zip`;

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              progress: 100,
              stage: "Complete! Starting download...",
              total: absoluteImageUrls.length,
              completed,
              zipData: Buffer.from(zipBuffer).toString("base64"),
              filename,
            })}\n\n`
          )
        );

        controller.close();
      } catch (error) {
        console.error("Error:", error);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: "Internal server error" })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
