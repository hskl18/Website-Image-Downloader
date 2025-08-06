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
            <strong>All Image Types:</strong> jpg, jpeg, png, gif, webp, svg,
            bmp, ico, tiff, avif, jfif
          </li>
          <li>
            <strong>IMG Elements:</strong> All src, data-src, data-original,
            data-lazy, srcset attributes
          </li>
          <li>
            <strong>CSS Images:</strong> background-image, background, content,
            list-style-image, border-image
          </li>
          <li>
            <strong>Meta Images:</strong> Open Graph, Twitter Cards, thumbnails
          </li>
          <li>
            <strong>Icons & Favicons:</strong> All favicon variants,
            apple-touch-icons, manifest icons
          </li>
          <li>
            <strong>Media Elements:</strong> Video posters, picture sources,
            object/embed images
          </li>
          <li>
            <strong>Inline Content:</strong> SVG elements, data URLs
          </li>
          <li>
            <strong>Smart Detection:</strong> Logos, banners, heroes, avatars,
            thumbnails
          </li>
        </ul>
        <p style={{ marginTop: "12px", fontSize: "14px", color: "#64748b" }}>
          ✨ <strong>Enhanced:</strong> Automatic duplicate removal, organized
          folders (images/, icons/, logos/, svgs/, banners/), and comprehensive
          asset detection
        </p>
      </div>
    </div>
  );
}
