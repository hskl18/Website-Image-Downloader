import { describe, expect, it, vi } from "vitest";

import {
  ByteBudget,
  readResponseBytes,
} from "../lib/server/response-limits";

describe("total download byte budget", () => {
  it("rejects bytes beyond the shared request budget", () => {
    const budget = new ByteBudget(10);

    budget.consume(6);
    budget.consume(4);

    expect(() => budget.consume(1)).toThrow("Download exceeds safety limits");
  });

  it("cancels an oversized response body before rejecting it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const response = new Response(body, {
      headers: { "content-length": "11" },
    });

    await expect(readResponseBytes(response, 10)).rejects.toThrow(
      "Download exceeds safety limits",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a streaming response when the shared budget is exceeded", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    });
    const response = new Response(body);

    await expect(
      readResponseBytes(response, 10, new ByteBudget(5)),
    ).rejects.toThrow("Download exceeds safety limits");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
