let puppeteer: any;
try {
  puppeteer = require("puppeteer");
} catch (e) {
  console.log("Puppeteer not available, dynamic scraping will be disabled");
}

export interface ScrapedImage {
  url: string;
  type: "img" | "background" | "lazy" | "api" | "next-image" | "meta";
  element?: string;
  alt?: string;
  className?: string;
}

export async function scrapeDynamicImages(
  url: string
): Promise<ScrapedImage[]> {
  if (!puppeteer) {
    throw new Error("Puppeteer not available");
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();

    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Track network requests to capture API calls and image URLs
    const imageUrls = new Set<string>();
    const apiImageUrls = new Set<string>();

    // Intercept network requests
    await page.setRequestInterception(true);
    page.on("request", (request: any) => {
      const requestUrl = request.url();
      const resourceType = request.resourceType();

      // Allow all requests but track image requests
      if (resourceType === "image") {
        imageUrls.add(requestUrl);
      }

      request.continue();
    });

    // Listen for responses to capture API data
    page.on("response", async (response: any) => {
      const responseUrl = response.url();
      const contentType = response.headers()["content-type"] || "";

      // Check for JSON API responses that might contain image URLs
      if (
        contentType.includes("application/json") &&
        response.status() === 200
      ) {
        try {
          const jsonData = await response.json();
          const imageUrlsFromApi = extractImageUrlsFromJson(jsonData);
          imageUrlsFromApi.forEach((url) => apiImageUrls.add(url));
        } catch (e) {
          // Ignore JSON parsing errors
        }
      }
    });

    // Navigate to the page
    await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });

    // Wait for initial content to load
    await page.waitForTimeout(8000);

    // Scroll to trigger lazy loading multiple times with longer waits
    await autoScroll(page);
    await page.waitForTimeout(5000);

    // Scroll again to catch any additional lazy loading
    await autoScroll(page);
    await page.waitForTimeout(5000);

    // Third scroll pass for stubborn lazy loaders
    await autoScroll(page);
    await page.waitForTimeout(3000);

    // Try to click any "Load More" or similar buttons
    try {
      const loadMoreSelectors = [
        'button[class*="load"]',
        'button[class*="more"]',
        'a[class*="load"]',
        'a[class*="more"]',
        ".load-more",
        ".show-more",
        '[data-testid*="load"]',
        '[data-testid*="more"]',
      ];

      for (const selector of loadMoreSelectors) {
        const elements = await page.$$(selector);
        for (const element of elements) {
          try {
            // Check if element is visible and clickable
            const isVisible = await element.isIntersectingViewport();
            if (isVisible) {
              await element.click();
              await page.waitForTimeout(3000); // Wait longer for content to load
            }
          } catch (e) {
            // Ignore click errors
          }
        }
      }
    } catch (e) {
      // Ignore if no load more buttons found
    }

    // Final scroll and wait
    await autoScroll(page);
    await page.waitForTimeout(8000);

    // Execute JavaScript to find all images including dynamically loaded ones
    const scrapedImages = await page.evaluate(() => {
      const images: ScrapedImage[] = [];

      // Find all img elements (including dynamically added ones)
      const imgElements = document.querySelectorAll("img");
      imgElements.forEach((img) => {
        // Check multiple possible src attributes
        const possibleSrcs = [
          img.src,
          img.getAttribute("data-src"),
          img.getAttribute("data-original"),
          img.getAttribute("data-lazy"),
          img.getAttribute("data-lazy-src"),
          img.getAttribute("data-echo"),
          img.getAttribute("data-url"),
          img.getAttribute("data-hi-res-src"),
          img.getAttribute("data-original-src"),
          img.getAttribute("data-retina-src"),
          img.getAttribute("data-2x"),
          img.getAttribute("data-3x"),
          img.getAttribute("data-4x"),
          img.getAttribute("data-large"),
          img.getAttribute("data-medium"),
          img.getAttribute("data-small"),
          img.getAttribute("data-thumb"),
          img.getAttribute("data-thumbnail"),
          img.getAttribute("data-image"),
          img.getAttribute("data-img"),
          img.getAttribute("data-photo"),
          img.getAttribute("data-picture"),
        ];

        possibleSrcs.forEach((src) => {
          if (
            src &&
            src !== "data:," &&
            src !== "" &&
            !src.startsWith("data:image/svg+xml;base64,") &&
            src.length > 10
          ) {
            images.push({
              url: src,
              type: "img",
              element: img.tagName.toLowerCase(),
              alt: (img as HTMLImageElement).alt,
              className: (img as HTMLImageElement).className,
            });
          }
        });

        // Check for srcset
        const srcset = img.srcset || img.getAttribute("data-srcset");
        if (srcset) {
          const srcsetUrls = srcset
            .split(",")
            .map((s) => s.trim().split(/\s+/)[0]);
          srcsetUrls.forEach((srcUrl) => {
            if (srcUrl && !srcUrl.startsWith("data:")) {
              images.push({
                url: srcUrl,
                type: "img",
                element: "img[srcset]",
                alt: (img as HTMLImageElement).alt,
                className: (img as HTMLImageElement).className,
              });
            }
          });
        }

        // Check for lazy loading attributes
        const lazyAttrs = [
          "data-src",
          "data-original",
          "data-lazy",
          "data-echo",
          "data-url",
        ];
        lazyAttrs.forEach((attr) => {
          const lazySrc = img.getAttribute(attr);
          if (lazySrc && !lazySrc.startsWith("data:")) {
            images.push({
              url: lazySrc,
              type: "lazy",
              element: `img[${attr}]`,
              alt: (img as HTMLImageElement).alt,
              className: (img as HTMLImageElement).className,
            });
          }
        });
      });

      // Find background images in computed styles
      const allElements = document.querySelectorAll("*");
      allElements.forEach((element) => {
        const computedStyle = window.getComputedStyle(element);
        const backgroundImage = computedStyle.backgroundImage;

        if (backgroundImage && backgroundImage !== "none") {
          const urlMatch = backgroundImage.match(
            /url\(['"]?([^'")\s]+)['"]?\)/
          );
          if (urlMatch && urlMatch[1] && !urlMatch[1].startsWith("data:")) {
            images.push({
              url: urlMatch[1],
              type: "background",
              element: element.tagName.toLowerCase(),
              className: element.className,
            });
          }
        }
      });

      // Look for common e-commerce image containers and data attributes
      const ecommerceSelectors = [
        "[data-image-url]",
        "[data-img-url]",
        "[data-src-large]",
        "[data-src-medium]",
        "[data-src-small]",
        "[data-product-image]",
        "[data-thumbnail]",
        "[data-zoom-image]",
        "[data-full-image]",
        ".product-image img",
        ".item-image img",
        ".thumbnail img",
        ".gallery img",
        ".slider img",
        ".carousel img",
        '[class*="product"] img',
        '[class*="item"] img',
        '[class*="card"] img',
        '[class*="tile"] img',
      ];

      ecommerceSelectors.forEach((selector) => {
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach((element) => {
            // Check for data attributes
            const dataAttrs = [
              "data-image-url",
              "data-img-url",
              "data-src-large",
              "data-src-medium",
              "data-src-small",
              "data-product-image",
              "data-thumbnail",
              "data-zoom-image",
              "data-full-image",
            ];

            dataAttrs.forEach((attr) => {
              const value = element.getAttribute(attr);
              if (value && value.length > 10) {
                images.push({
                  url: value,
                  type: "img",
                  element: selector,
                  className: element.className,
                });
              }
            });
          });
        } catch (e) {
          // Ignore selector errors
        }
      });

      // Find Next.js optimized images
      const nextImages = document.querySelectorAll('img[src*="_next/image"]');
      nextImages.forEach((img) => {
        const src = (img as HTMLImageElement).src;
        if (src) {
          // Extract original URL from Next.js optimized URL
          const urlMatch = src.match(/[?&]url=([^&]+)/);
          if (urlMatch) {
            try {
              const originalUrl = decodeURIComponent(urlMatch[1]);
              images.push({
                url: originalUrl,
                type: "next-image",
                element: "next-image",
                alt: (img as HTMLImageElement).alt,
                className: (img as HTMLImageElement).className,
              });
            } catch (e) {
              // If decoding fails, use the Next.js URL
              images.push({
                url: src,
                type: "next-image",
                element: "next-image",
                alt: (img as HTMLImageElement).alt,
                className: (img as HTMLImageElement).className,
              });
            }
          }
        }
      });

      // Find meta images (Open Graph, Twitter, etc.)
      const metaSelectors = [
        'meta[property="og:image"]',
        'meta[property="og:image:url"]',
        'meta[name="twitter:image"]',
        'meta[name="thumbnail"]',
      ];

      metaSelectors.forEach((selector) => {
        const metaElements = document.querySelectorAll(selector);
        metaElements.forEach((meta) => {
          const content = meta.getAttribute("content");
          if (content) {
            images.push({
              url: content,
              type: "meta",
              element: selector,
            });
          }
        });
      });

      return images;
    });

    // Combine all found images
    const allImages: ScrapedImage[] = [...scrapedImages];

    // Add images from network requests
    imageUrls.forEach((url) => {
      allImages.push({
        url,
        type: "img",
        element: "network-request",
      });
    });

    // Add images from API responses
    apiImageUrls.forEach((url) => {
      allImages.push({
        url,
        type: "api",
        element: "api-response",
      });
    });

    return allImages;
  } catch (error) {
    console.error("Browser scraping failed:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Helper function to extract image URLs from JSON responses
function extractImageUrlsFromJson(data: any): string[] {
  const imageUrls: string[] = [];

  function traverse(obj: any, key?: string) {
    if (typeof obj === "string" && obj.length > 10) {
      // Check if string looks like an image URL
      const isImageUrl =
        /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|avif)(\?.*)?$/i.test(obj) ||
        obj.includes("image") ||
        obj.includes("img") ||
        obj.includes("photo") ||
        obj.includes("pic") ||
        obj.includes("thumb") ||
        obj.includes("cdn") ||
        (key &&
          (key.toLowerCase().includes("image") ||
            key.toLowerCase().includes("img") ||
            key.toLowerCase().includes("photo") ||
            key.toLowerCase().includes("pic") ||
            key.toLowerCase().includes("thumb") ||
            key.toLowerCase().includes("url") ||
            key.toLowerCase().includes("src")));

      if (isImageUrl && (obj.startsWith("http") || obj.startsWith("//"))) {
        imageUrls.push(obj);
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, index) => traverse(item, `${key}[${index}]`));
    } else if (obj && typeof obj === "object") {
      Object.entries(obj).forEach(([k, v]) => traverse(v, k));
    }
  }

  traverse(data);
  return imageUrls;
}

// Helper function to auto-scroll the page to trigger lazy loading
async function autoScroll(page: any) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 150; // Smaller scroll distance for better lazy loading detection
      let previousHeight = 0;
      let stuckCount = 0;
      let scrollAttempts = 0;
      const maxScrollAttempts = 100; // Prevent infinite scrolling

      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        scrollAttempts++;

        // Check if we're stuck (page height hasn't changed)
        if (scrollHeight === previousHeight) {
          stuckCount++;
        } else {
          stuckCount = 0;
          previousHeight = scrollHeight;
        }

        // If we've reached the bottom, been stuck for too long, or exceeded max attempts, stop
        if (
          totalHeight >= scrollHeight ||
          stuckCount > 15 ||
          scrollAttempts > maxScrollAttempts
        ) {
          clearInterval(timer);

          // Multi-pass scrolling to catch different lazy loading patterns
          setTimeout(() => {
            // Scroll back to top to trigger any additional lazy loading
            window.scrollTo(0, 0);
            setTimeout(() => {
              // Scroll to 25%
              window.scrollTo(0, scrollHeight * 0.25);
              setTimeout(() => {
                // Scroll to 50%
                window.scrollTo(0, scrollHeight * 0.5);
                setTimeout(() => {
                  // Scroll to 75%
                  window.scrollTo(0, scrollHeight * 0.75);
                  setTimeout(() => {
                    // Scroll back to bottom
                    window.scrollTo(0, scrollHeight);
                    resolve();
                  }, 800);
                }, 800);
              }, 800);
            }, 800);
          }, 800);
        }
      }, 300); // Slower scrolling to give more time for images to load
    });
  });
}
