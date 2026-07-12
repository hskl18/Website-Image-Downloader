import { describe, expect, it, vi } from "vitest";

import { mapWithConcurrency } from "../lib/server/concurrency";

describe("bounded worker lifecycle", () => {
  it("waits for every started worker before propagating an error", async () => {
    let finishSecondWorker: (() => void) | undefined;
    const secondWorker = new Promise<void>((resolve) => {
      finishSecondWorker = resolve;
    });
    const worker = vi.fn(async (_item: string, index: number) => {
      if (index === 0) throw new Error("blocked download");
      await secondWorker;
    });

    let settled = false;
    const operation = mapWithConcurrency(
      ["first", "second", "must-not-start"],
      2,
      worker,
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));

    expect(settled).toBe(false);
    finishSecondWorker?.();
    await expect(operation).rejects.toThrow("blocked download");
    expect(worker).toHaveBeenCalledTimes(2);
  });
});
