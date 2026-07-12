# Security Model

Website Image Downloader accepts an untrusted public URL, fetches the referenced HTML, downloads a bounded set of detected images, and returns a ZIP archive.
The service must treat the submitted URL, every DNS response, every redirect, all page markup, every image response, and every remote filename as untrusted.

## Trust boundaries

The service is allowed to reach public HTTP and HTTPS destinations on standard ports.
It is not allowed to reach the host network, private address space, link-local services, cloud metadata endpoints, IPv4 transition addresses, or other non-global special-purpose ranges.
DNS validation alone is insufficient, so the validated address is pinned into the outbound connection and each redirect is validated again.

## Attack matrix

| Threat | Implemented control | Verification |
| --- | --- | --- |
| Direct SSRF to local or private IPs | IPv4 and IPv6 blocklists reject non-public ranges before fetch | Route tests cover loopback, RFC 1918, metadata, NAT64, discard-only, IETF assignment, and 6to4 inputs |
| DNS rebinding | Every hostname is resolved once, all answers must be public, and the selected answer is pinned into Undici lookup | Test changes the resolver to loopback after validation and confirms the connection still uses the pinned public address |
| Redirect to a private target | Redirects are manual, bounded, and revalidated before the next connection | Test redirects a public URL to loopback and expects a policy error |
| Undici multi-address lookup mismatch | Pinned lookup supports both a single result and the `{ all: true }` result array | Regression test exercises the exact multi-address callback shape |
| Oversized request or URL | JSON body is limited to 4 KiB and URL text to 2,048 characters | Declared and streamed body-limit tests fail before egress |
| Oversized page or image | Page, per-image, total-image, candidate-count, and concurrency limits are applied before ZIP generation | Response-limit and concurrency tests cover declared and streamed excess |
| Content-type confusion | Explicit non-HTML page responses are rejected and image formats are derived from strong byte signatures | Tests reject PDF pages, arbitrary RIFF and BM prefixes, and invalid image bytes |
| Misleading or dangerous filenames | Remote extensions are discarded, names are normalized, and detected formats choose the archive extension | Format tests cover JPEG, PNG, GIF, WebP, and extension mismatch |
| Early worker failure releasing capacity | New work stops after the first fatal failure and every started worker settles before the job slot is released | Lifecycle tests keep another download pending and confirm a third job still receives `429` |
| Shared-cache exposure | API success and error responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` | Route assertions and hosted header smoke |

## Deliberate limitations

The in-process job limiter is defense in depth and is not a durable multi-instance rate limiter.
A hosted deployment still needs platform-level rate limiting, abuse monitoring, alerting, and a global resource budget.

The extractor parses returned HTML only.
It does not run target JavaScript, authenticate to websites, bypass robots or access controls, or discover resources that appear only after client-side execution.

Timeouts are applied to each outbound request.
The public deployment should also enforce a platform request-duration limit appropriate to its runtime.
