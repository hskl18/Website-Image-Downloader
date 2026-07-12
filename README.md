# Website Image Downloader

Website Image Downloader is a bounded Next.js service that extracts public image URLs from a webpage and returns the downloaded files as a ZIP archive.
The implementation focuses on safe outbound requests, predictable resource use, and reproducible verification.

## Safety boundaries

- Only public HTTP and HTTPS destinations on standard ports are allowed.
- DNS results are validated and pinned to the outbound connection to reduce DNS-rebinding risk.
- Every redirect is resolved, validated, and pinned again.
- Loopback, private, link-local, and cloud metadata destinations are rejected.
- A page response is limited to 2 MiB.
- Each image is limited to 8 MiB, and one archive is limited to 32 MiB.
- One request processes at most 40 images with four concurrent image downloads.
- One process handles at most two archive jobs at a time and returns `429` with `Retry-After` when full.
- Outbound requests time out after 10 seconds.

These process-local limits are defense in depth.
A multi-instance deployment should also use platform-level rate limiting and abuse monitoring.

## Supported extraction

- HTML `<img src>` attributes.
- CSS `background-image` URLs found in inline styles.
- Relative image URLs resolved against the final public page URL.
- ZIP filenames normalized and deduplicated before download.

## Local development

Use Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Open <http://localhost:3000>.

The post-install script installs the Chrome build used by Puppeteer.
Set `PUPPETEER_SKIP_DOWNLOAD=true` only in environments that do not execute browser-backed scraping.

## Verification

```bash
npm audit
npm test
npm run lint
npm run typecheck
npm run build
```

The test suite covers blocked network ranges, redirect validation, DNS rebinding, response limits, body cancellation, concurrency limits, and API error responses.

## API

`POST /api/download-images` accepts JSON with a public `url` and returns a ZIP archive when at least one supported image can be downloaded within the configured limits.

## License

This project is available under the [MIT License](LICENSE).
