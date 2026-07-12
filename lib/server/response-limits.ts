export class ResponseLimitError extends Error {
  constructor() {
    super("Download exceeds safety limits");
    this.name = "ResponseLimitError";
  }
}

export class ByteBudget {
  private remainingBytes: number;

  constructor(maxBytes: number) {
    this.remainingBytes = maxBytes;
  }

  consume(byteCount: number) {
    if (byteCount > this.remainingBytes) {
      throw new ResponseLimitError();
    }

    this.remainingBytes -= byteCount;
  }
}

export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  budget?: ByteBudget,
) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new ResponseLimitError();
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new ResponseLimitError();
      }

      budget?.consume(value.byteLength);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}
