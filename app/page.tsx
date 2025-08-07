"use client";

import { useState } from "react";

interface ProgressState {
  progress: number;
  stage: string;
  total: number;
  completed: number;
  currentFile?: string;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [progressState, setProgressState] = useState<ProgressState>({
    progress: 0,
    stage: "",
    total: 0,
    completed: 0,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url) {
      setError("Please enter a valid URL");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");
    setProgressState({
      progress: 0,
      stage: "Analyzing webpage...",
      total: 0,
      completed: 0,
    });

    try {
      const response = await fetch("/api/download-images", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to download images");
      }

      setProgressState({
        progress: 80,
        stage: "Preparing download...",
        total: 0,
        completed: 0,
      });

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
        link.download = `images-${Date.now()}.zip`;
      }

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);

      setProgressState({
        progress: 100,
        stage: "Download complete!",
        total: 0,
        completed: 0,
      });
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
              <span>Processing...</span>
            </>
          ) : (
            "Download All Images"
          )}
        </button>
      </form>

      {loading && (
        <div className="progress-container">
          <div className="progress-info">
            <div className="progress-stage">{progressState.stage}</div>
            {progressState.total > 0 && (
              <div className="progress-stats">
                {progressState.completed}/{progressState.total} images
              </div>
            )}
            {progressState.currentFile && (
              <div className="current-file">
                Currently: {progressState.currentFile}
              </div>
            )}
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progressState.progress}%` }}
            ></div>
          </div>
          <div className="progress-percentage">{progressState.progress}%</div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="info-box">
        <h3>What gets downloaded:</h3>
        <ul>
          <li>
            <strong>Image Elements:</strong> All img tags with src, data-src,
            srcset attributes
          </li>
          <li>
            <strong>Background Images:</strong> CSS background-image properties
          </li>
          <li>
            <strong>Social Media Images:</strong> Open Graph and Twitter Card
            images
          </li>
          <li>
            <strong>Icons & Favicons:</strong> Site icons and favicons
          </li>
          <li>
            <strong>Smart Filtering:</strong> Skips tracking pixels, duplicates,
            and invalid images
          </li>
          <li>
            <strong>All Formats:</strong> jpg, png, gif, webp, svg, ico, and
            more
          </li>
        </ul>
        <p style={{ marginTop: "12px", fontSize: "14px", color: "#64748b" }}>
          ✨ <strong>Fast & Reliable:</strong> Streamlined approach inspired by
          extract.pics for better performance and success rates
        </p>
      </div>
    </div>
  );
}
