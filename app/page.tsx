"use client";

import { useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url) {
      setError("Please enter a valid URL");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch("/api/download-images", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        throw new Error("Failed to download images");
      }

      // Get the zip file as blob
      const blob = await response.blob();

      // Create download link
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;

      // Extract hostname from URL for filename
      try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace(/^www\./, "");
        const sanitizedHostname = hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
        link.download = `${sanitizedHostname}_images.zip`;
      } catch {
        link.download = `images-${new Date().getTime()}.zip`;
      }

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);

      setSuccess("Images downloaded successfully!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <h1 className="title">Website Image Downloader</h1>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="url" className="label">
            Website URL:
          </label>
          <input
            type="url"
            id="url"
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            required
          />
        </div>

        <button
          type="submit"
          className="button"
          disabled={loading}
          style={{ width: "100%" }}
        >
          {loading ? (
            <>
              <span className="loading"></span>
              <span>Downloading...</span>
            </>
          ) : (
            "Download All Images"
          )}
        </button>
      </form>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="info-box">
        <h3>What gets downloaded:</h3>
        <ul>
          <li>
            <strong>Images:</strong> All img tags (jpg, png, gif, webp, svg,
            bmp, ico, avif)
          </li>
          <li>
            <strong>Icons & Favicons:</strong> favicon.ico, apple-touch-icons,
            mask-icons, and manifest icons
          </li>
          <li>
            <strong>Logos:</strong> Images with "logo" in alt text, class, or ID
          </li>
          <li>
            <strong>SVGs:</strong> Inline SVG elements and SVG files
          </li>
          <li>
            <strong>Backgrounds:</strong> CSS background images
          </li>
          <li>
            <strong>Lazy loaded:</strong> Images with data-src attributes
          </li>
        </ul>
        <p style={{ marginTop: "12px", fontSize: "14px", color: "#64748b" }}>
          Images are organized into folders: images/, icons/, logos/, and svgs/
        </p>
      </div>
    </div>
  );
}
