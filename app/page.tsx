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
      stage: "Starting...",
      total: 0,
      completed: 0,
    });

    try {
      // Try streaming API first
      const response = await fetch("/api/download-images-stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        throw new Error("Failed to start download process");
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("Failed to read response stream");
      }

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.error) {
                setError(data.error);
                setLoading(false);
                return;
              }

              if (data.progress !== undefined) {
                setProgressState({
                  progress: data.progress,
                  stage: data.stage,
                  total: data.total,
                  completed: data.completed,
                  currentFile: data.currentFile,
                });
              }

              if (data.zipData && data.filename) {
                // Convert base64 to blob and download
                const binaryString = atob(data.zipData);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                  bytes[i] = binaryString.charCodeAt(i);
                }
                const blob = new Blob([bytes], { type: "application/zip" });

                const downloadUrl = window.URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = downloadUrl;
                link.download = data.filename;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(downloadUrl);

                setSuccess(`Successfully downloaded ${data.completed} images!`);
              }
            } catch (parseError) {
              console.error("Failed to parse progress data:", parseError);
            }
          }
        }
      }
    } catch (err) {
      console.error("Streaming failed, trying fallback:", err);

      // Fallback to original API
      try {
        setProgressState({
          progress: 0,
          stage: "Using fallback method...",
          total: 0,
          completed: 0,
        });

        const fallbackResponse = await fetch("/api/download-images", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url }),
        });

        if (!fallbackResponse.ok) {
          throw new Error("Failed to download images");
        }

        setProgressState({
          progress: 90,
          stage: "Preparing download...",
          total: 0,
          completed: 0,
        });

        const blob = await fallbackResponse.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;

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
      } catch (fallbackErr) {
        setError(
          fallbackErr instanceof Error
            ? fallbackErr.message
            : "An error occurred"
        );
      }
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
