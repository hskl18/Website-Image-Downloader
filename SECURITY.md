# Security Policy

Website Image Downloader makes server-side requests to URLs that users submit, so a bypass of its egress policy is the most serious kind of bug it can have.

## Supported versions

Security fixes go to `main`, which is what the live demo runs, and to the latest release.

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/hskl18/Website-Image-Downloader/security/advisories/new).
Do not open a public issue for an unfixed vulnerability.

In scope:

- Any way to make the server connect to a loopback, private, link-local, metadata, or other non-public address, directly or through DNS, redirects, or URL parsing.
- Any way to exceed the documented time, byte, image-count, or concurrency limits in a single request.
- Any way to get a file into the archive that is not a JPEG, PNG, GIF, or WebP, or to control its path inside the archive.

Out of scope, because the README already lists them as limits:

- Volume abuse across many requests or instances, since the job limit is per process.
- Images that static extraction does not find.

## Testing against the live demo

Please reproduce locally with `npm ci && npm run dev` instead of sending high request volumes to <https://website-image-downloader.vercel.app>.
Single requests that show a bypass, such as the curl example in the README, are fine.

## Security model

The controls, the threats they answer, and the tests that cover them are listed in [docs/security-model.md](docs/security-model.md).
[DESIGN.md](DESIGN.md) explains the decisions behind them and their known limits.
