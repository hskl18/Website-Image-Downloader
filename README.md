# Website Image Downloader

A Next.js application that allows users to download all images from any website as a ZIP file.

## Features

- Enter any website URL
- Automatically scans for all images (jpg, png, gif, webp, svg, bmp, ico)
- Downloads images from both `<img>` tags and CSS background images
- Packages all images into a downloadable ZIP file
- Clean, responsive user interface

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Run the development server:

```bash
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000) in your browser

## How it works

1. User enters a website URL
2. The app fetches the webpage HTML
3. Uses Cheerio to parse and extract image URLs from:
   - `<img>` src attributes
   - CSS background-image properties
4. Converts relative URLs to absolute URLs
5. Downloads all images concurrently
6. Creates a ZIP file using JSZip
7. Serves the ZIP file for download

## Technologies Used

- Next.js 14 (App Router)
- TypeScript
- Cheerio (HTML parsing)
- JSZip (ZIP file creation)
- Tailwind CSS (styling)

## API Endpoints

- `POST /api/download-images` - Downloads images from a given URL and returns a ZIP file
