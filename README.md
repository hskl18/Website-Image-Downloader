# Website Image Downloader

Website Image Downloader is a bounded Next.js service that extracts public image URLs from a webpage and returns the downloaded files as a ZIP archive.
The implementation focuses on safe outbound requests, predictable resource use, and reproducible verification.

## Safety boundaries

- Only public HTTP and HTTPS destinations on standard ports are allowed.
- DNS results are validated and pinned to the outbound connection to reduce DNS-rebinding risk.
- Every redirect is resolved, validated, and pinned again.
- Loopback, private, link-local, transition, special-purpose, and cloud metadata destinations are rejected.
- The denylist tracks the [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) and [IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml) special-purpose registries.
- Request JSON is limited to 4 KiB and the submitted URL is limited to 2,048 characters.
- A page response is limited to 2 MiB.
- Explicit non-HTML page responses are rejected before parsing.
- Each image is limited to 8 MiB, and one archive is limited to 32 MiB.
- Discovery retains at most 160 raw candidates, and one request downloads at most 40 images with four concurrent image downloads.
- One process handles at most two archive jobs at a time and returns `429` with `Retry-After` when full.
- Outbound requests time out after 10 seconds.
- Image extensions come from verified JPEG, PNG, GIF, or WebP signatures rather than remote filenames or MIME claims.

These process-local limits are defense in depth.
A multi-instance deployment should also use platform-level rate limiting and abuse monitoring.
See the versioned [security model and attack matrix](docs/security-model.md) for implemented controls and hosted deployment gates.

## Supported extraction

- HTML `<img src>` attributes.
- CSS `background-image` URLs found in inline styles.
- Relative image URLs resolved against the final public page URL.
- ZIP filenames normalized and deduplicated before download.

Extraction is static.
The service does not execute a target page's JavaScript, bypass access controls, or guarantee discovery of every image visible in a browser.

## Local development

Use Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Open <http://localhost:3000>.

## Verification

```bash
npm audit
npm test
npm run lint
npm run typecheck
npm run build
```

The test suite covers Undici's pinned lookup contract, blocked network ranges, redirect validation, DNS rebinding, input and response limits, final-URL handling, byte-level image validation, body cancellation, worker lifecycle, job concurrency, and API error responses.

## API

`POST /api/download-images` accepts JSON with a public `url` and returns a ZIP archive when at least one supported image can be downloaded within the configured limits.

## License

This project is available under the [MIT License](LICENSE).
