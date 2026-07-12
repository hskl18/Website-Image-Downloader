const FALLBACK_FILENAME = "public-page-images.zip";

export function getDownloadFilename(response: Response) {
  const disposition = response.headers.get("content-disposition");
  const filename = disposition?.match(/filename="([a-zA-Z0-9._-]+)"/i)?.[1];
  return filename || FALLBACK_FILENAME;
}
