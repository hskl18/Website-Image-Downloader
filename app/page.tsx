"use client";

import { useState } from "react";

import { getDownloadFilename } from "../lib/client/download-filename";

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url) {
      setError("Enter a public HTTP or HTTPS page URL.");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch("/api/download-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "The archive could not be created.");
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = getDownloadFilename(response);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);
      setSuccess("Your bounded ZIP archive is ready.");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "The archive could not be created.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="container">
      <header className="hero">
        <p className="eyebrow">Public-web utility</p>
        <h1 className="title">Build a bounded image archive</h1>
        <p className="subtitle">
          Extract image files referenced by a public HTML page without giving
          the service access to private networks or unbounded downloads.
        </p>
      </header>

      <form className="download-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="url" className="label">
            Public page URL
          </label>
          <input
            type="url"
            id="url"
            name="url"
            className="input"
            autoComplete="off"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/gallery…"
            required
            aria-describedby="url-help"
          />
          <p id="url-help" className="field-help">
            Standard HTTP and HTTPS ports only. Redirects and DNS answers are
            revalidated before every connection.
          </p>
        </div>

        <button type="submit" className="button" disabled={loading}>
          {loading ? (
            <>
              <span className="loading" aria-hidden="true" />
              <span>Building archive…</span>
            </>
          ) : (
            "Create bounded ZIP"
          )}
        </button>
      </form>

      <div className="result-region" aria-live="polite">
        {loading && (
          <p className="status">Fetching within fixed safety limits…</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {success && <p className="success">{success}</p>}
      </div>

      <section className="boundary-grid" aria-labelledby="boundaries-title">
        <h2 id="boundaries-title" className="section-title">
          Explicit boundaries
        </h2>
        <article className="boundary-card">
          <p className="boundary-value">40 files</p>
          <h3>Static discovery</h3>
          <p>
            Reads image, source-set, inline background, social, and icon URLs
            from returned HTML.
          </p>
        </article>
        <article className="boundary-card">
          <p className="boundary-value">32 MiB total</p>
          <h3>Resource limits</h3>
          <p>
            Caps the page at 2 MiB and each detected image at 8 MiB before
            creating the ZIP.
          </p>
        </article>
        <article className="boundary-card">
          <p className="boundary-value">4 formats</p>
          <h3>Byte-verified files</h3>
          <p>
            Accepts JPEG, PNG, GIF, and WebP based on file signatures, not URL
            claims.
          </p>
        </article>
        <article className="boundary-card">
          <p className="boundary-value">Public only</p>
          <h3>Restricted egress</h3>
          <p>
            Blocks local, private, metadata, link-local, transition, and
            nonstandard-port targets.
          </p>
        </article>
      </section>

      <p className="scope-note">
        This service does not run a target page&apos;s JavaScript, bypass access
        controls, or guarantee that every visible image can be discovered.
      </p>
    </main>
  );
}
