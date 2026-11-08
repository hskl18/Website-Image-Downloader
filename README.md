# Website Image Downloader

[![CI](https://github.com/hskl18/Website-Image-Downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/hskl18/Website-Image-Downloader/actions/workflows/ci.yml)

A Next.js service that takes a public webpage URL, downloads the images the page references, and returns them as one ZIP file.
It does this without letting the server reach private networks or spend unbounded time and memory on one request.

Live demo: <https://website-image-downloader.vercel.app>

**Status: v0.2.0, maintained demo.**
The demo runs the code on `main` with the limits below; it is a public demonstration, not a multi-tenant production service.

Any server that fetches a URL a user typed is an SSRF entry point.
The user can point it at `127.0.0.1`, a private network, or a cloud metadata endpoint, or reach them indirectly through DNS answers and redirects.
This project is a small, complete example of closing those paths and bounding the work one request can cause.

## Checked against production

On 2026-11-08, each request below was sent with curl to `POST /api/download-images` on the live demo.

| Submitted URL | What it tests | Response |
| --- | --- | --- |
| `https://www.python.org/` | a normal page | 200, a ZIP of 6 PNG files, each confirmed by its byte signature |
| `https://postman-echo.com/redirect-to?url=https://www.python.org/` | a redirect to a public page | 200, the same ZIP |
| `https://postman-echo.com/redirect-to?url=http://169.254.169.254/latest/meta-data/` | a public redirect to the metadata address | 400 |
| `http://169.254.169.254/latest/meta-data/` | the cloud metadata IP | 400 |
| `http://metadata.google.internal/computeMetadata/v1/` | a cloud metadata hostname | 400 |
| `http://127.0.0.1/`, `http://[::1]/`, `http://10.0.0.1/` | loopback and private ranges | 400 |
| `http://0x7f000001/`, `http://2130706433/` | hex and decimal spellings of loopback | 400 |
| `https://[::ffff:169.254.169.254]/` | the metadata address mapped into IPv6 | 400 |
| `http://localtest.me/`, `http://169.254.169.254.nip.io/` | public DNS names that resolve to loopback and metadata | 400 |

Every 400 had the body `{"error":"URL is not allowed"}` and `Cache-Control: no-store`.
To repeat one:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"url":"http://169.254.169.254/latest/meta-data/"}' \
  https://website-image-downloader.vercel.app/api/download-images
```

In CI, 44 tests run without internet access and cover blocked address ranges, private DNS answers, DNS rebinding, redirect revalidation, size limits, byte-level format checks, and job concurrency.
One of them sends the built-in `fetch` through the pinned `Agent` to a loopback server, which catches both real-connection failures in [DESIGN.md](DESIGN.md).
The [attack matrix](docs/security-model.md) maps each threat to its control and its test, and [DESIGN.md](DESIGN.md) explains the decisions and the failures found along the way.

## Run locally

```bash
npm ci && npm run dev
```

Then open <http://localhost:3000>.
It needs Node.js 22 or newer; CI runs the tests on Node.js 22, 24, and 26, because each line bundles its own undici.

## Non-goals

- It is not a crawler: it reads the returned HTML once and does not run page JavaScript, follow links, or log in.
- It does not bypass robots rules, paywalls, or other access controls, and it does not promise to find every image a browser would show.
- Its job limit is per process, so it is not a durable or multi-instance rate limiter.
  A real deployment needs platform rate limiting and abuse monitoring, which this repository does not configure.
- It does not judge content: any public JPEG, PNG, GIF, or WebP within the limits is returned.

## Limits

- Only `http` on port 80 and `https` on port 443 are allowed, and URLs with credentials are rejected.
- `localhost`, `*.localhost`, `metadata.google.internal`, and `metadata.goog` are rejected by name.
- Every DNS answer must be public, and the first answer is pinned into the outbound connection so a second lookup cannot change it.
- Redirects are followed manually, at most 3 times, and each target is validated and pinned again.
- Loopback, private, link-local, shared, transition, documentation, multicast, and other special-purpose ranges are rejected, following the [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) and [IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml) special-purpose registries.
- The request body must be JSON of at most 4 KiB, and the URL at most 2,048 characters.
- The page may be at most 2 MiB, and an explicit non-HTML response is rejected before parsing.
- Each image may be at most 8 MiB, and one archive at most 32 MiB.
- Discovery keeps at most 160 candidate URLs, and one request downloads at most 40 images, four at a time.
- One process runs at most two jobs at a time and answers `429` with `Retry-After: 5` when full.
- Each outbound request times out after 10 seconds, and the whole job after 30 seconds.
- Images under 1,000 bytes and byte-identical duplicates are skipped.
- File extensions come from JPEG, PNG, GIF, or WebP byte signatures, never from remote filenames or MIME types.

## What it extracts

- `<img>` `src`, `data-src`, or `data-original`, and every `srcset` candidate.
- Inline `style` `background-image` URLs.
- `og:image` and `twitter:image` meta tags.
- `<link rel="icon">` and other icon links.

Relative URLs resolve against the final page URL after redirects.
A candidate is kept only if its URL ends in an image extension or contains a word such as `image`, `photo`, `logo`, or `icon`.

## API

`POST /api/download-images` with `Content-Type: application/json` and a body of `{"url": "https://..."}`.
It returns `application/zip` when at least one image could be downloaded within the limits, and JSON `{"error": "..."}` with a 400, 404, 413, 415, 429, 500, or 504 status otherwise.
If any image breaks the egress policy or a size limit, the whole job fails closed instead of returning a partial archive.

## Verification

```bash
npm audit
npm test
npm run lint
npm run typecheck
npm run build
```

CI runs the same steps on every pull request and on `main`.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

This project is available under the [MIT License](LICENSE).
