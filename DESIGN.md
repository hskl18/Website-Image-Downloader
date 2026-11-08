# Design

Website Image Downloader fetches a page that a stranger chose, then fetches every image that page names.
Both hops are server-side requests to addresses an attacker controls, so the design starts from SSRF and resource exhaustion and treats extraction as the easy part.
The threat-by-threat list of controls and tests is in [docs/security-model.md](docs/security-model.md); this file explains why the controls look the way they do, what they cost, and what went wrong on the way.

## Request path

1. `app/api/download-images/route.ts` reads at most 4 KiB of JSON and parses the URL.
2. A process-wide `JobLimiter` admits at most two jobs, and a 30-second job deadline starts.
3. `safeFetch` in `lib/server/egress.ts` validates the URL, resolves it, pins the address, and fetches the page with manual redirects.
4. `readResponseBytes` in `lib/server/response-limits.ts` streams the page into a 2 MiB budget, and cheerio extracts at most 160 candidates.
5. `mapWithConcurrency` downloads at most 40 images four at a time, each through `safeFetch`, each within 8 MiB, all within a shared 32 MiB budget.
6. `detectImageFormat` keeps only JPEG, PNG, GIF, and WebP by byte signature, and JSZip builds the archive.

## Decisions

### Validate, then pin the address into the connection

Checking the hostname's DNS answer and then calling `fetch(url)` is not enough, because `fetch` resolves the name again.
An attacker's DNS server can answer with a public address for the check and `127.0.0.1` for the connection, which is DNS rebinding.
`assertSafeUrl` resolves the name once, rejects it if any answer is non-public, and returns the first answer.
`safeFetch` then creates an Undici `Agent` whose `connect.lookup` always returns that address, so the socket goes where the check looked.
The cost is one `Agent` per hop with no connection reuse, which is acceptable for one page and at most 40 images per job.

### Reject if any answer is private, not only the one used

A name with one public and one private answer is rejected outright.
Pinning would make it safe to use the public answer, but rejecting keeps the rule simple and independent of answer order.

### Follow redirects by hand

`fetch` is called with `redirect: "manual"`, so each `Location` goes back through `assertSafeUrl` and gets a fresh pinned `Agent`.
The production check in the README shows the difference: a public redirector pointed at `https://www.python.org/` returns a ZIP, and the same redirector pointed at `169.254.169.254` returns 400.
At most three redirects are followed.

### A denylist from the IANA registries

The service must reach arbitrary public hosts, so an allowlist of destinations is not possible.
The denylist in `lib/server/egress.ts` follows the IANA IPv4 and IPv6 special-purpose registries, including the ranges that wrap an IPv4 address inside IPv6 (`::ffff:0:0/96`, NAT64 `64:ff9b::/96`, and 6to4 `2002::/16`).
The cost is maintenance: a new special-purpose range is unprotected until the list is updated.
Port and scheme are pinned too, so `http` only reaches port 80 and `https` only reaches 443.

### Budgets are enforced while streaming

A declared `Content-Length` over the limit is refused before reading, but the declaration is not trusted.
`readResponseBytes` counts bytes as they arrive, cancels the body as soon as a limit is crossed, and charges every image to one shared `ByteBudget`.

### Fail the whole job closed

If any image download breaks the egress policy or a size limit, the job stops scheduling new downloads and returns 400 or 413 instead of a partial archive.
A response is then either a complete success within policy or an error, which is the easiest behavior to reason about.
Skipping the offending image would also be safe, because a blocked address is never contacted, so this is a usability trade-off rather than a security requirement.
The cost is that one oversized or private image reference on an otherwise ordinary page fails the whole request.
Ordinary per-image failures, such as a 404, a network error, or a file that is not a supported image, are skipped.

### Trust bytes, not names

Remote filenames and MIME types are hints from the attacker, so the archive extension comes from the first bytes of the file.
SVG, BMP, AVIF, and every other format outside those four are dropped.

## Failures found and fixed

### The pinned lookup broke every real download (fixed in #5)

PR #3 (`2abddf5`) introduced the pinned lookup as a function that ignored its options and always answered `callback(null, address, family)`.
Node.js calls the lookup with `{ all: true }` when it connects, and then expects an array of addresses.
The tests mocked `fetch`, so they passed while every real outbound request failed.
PR #5 (`a2d47af`) answers in the shape that was asked for and adds the regression test `returns the pinned address shape requested by Undici`.
Re-running the July 12 lookup on 2026-11-08 against `https://www.python.org/` through the same `Agent` failed with `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` on Node.js 22.23.4 and 24.22.2, and the fixed lookup returned 200 on both.

### A failed image released the job slot early (fixed in #5)

The first `mapWithConcurrency` used `Promise.all` over its workers, so the first fatal error rejected the job while other workers were still downloading.
The route then released its job slot, and a third job could start while the first was still using bandwidth and memory.
PR #5 records the first failure, stops scheduling, and waits for every started worker before it rethrows.
Running the current test `keeps the job slot until every started image download settles` against the old `lib/server/concurrency.ts` from `e61bd6a` on 2026-11-08 fails: the third job is admitted and gets 500 instead of 429.

### Node.js 26 rejected the pinned Agent (fixed in #13)

`safeFetch` passes an `Agent` from the `undici` package to the `fetch` that Node.js bundles, so the two versions have to agree.
With `undici` 6.29.1, Node.js 26.13.0, which bundles undici 8.12.2, rejected the `Agent` with `UND_ERR_INVALID_ARG: invalid onError method`, and every real download returned 500 under `next start`.
The tests passed for the same reason as the first failure: they stub `fetch`.
PR #13 moves to `undici` 7.30.2, and real downloads under `next start` returned 200 on Node.js 22.23.4, 24.22.2, and 26.13.0.

### The first version had no egress policy (fixed in #3)

From August 2025 until PR #3 in July 2026, the route fetched any submitted URL and every discovered image with plain `fetch`, all images at once through `Promise.all`.
It had no address checks and no byte budget; the only limit was a 10-second timeout on each image request.
That was a working SSRF, including the cloud metadata address, and a memory-exhaustion path.

## Limits

- The two-job limit is per process, and a serverless platform can run many processes, so it bounds one instance rather than the service.
- Only the first DNS answer is used, so a host whose first address is unreachable fails instead of falling back to another address.
- Protection is in the application only; nothing at the network layer stops a future code path that calls `fetch` directly.
- The unit tests stub `fetch`, so the real connection path is covered only by the manual production check in the README; the first and third failures above are what that gap costs.
  A test that opens a real loopback connection through `safeFetch` with a test-only policy would close it.
- Extraction is static HTML only, and the URL filter skips images whose URL has neither an image extension nor a word like `image` or `logo`.
