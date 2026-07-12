export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let nextIndex = 0;
  let failure: unknown;

  async function runWorker() {
    while (failure === undefined && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runWorker(),
    ),
  );
  if (failure !== undefined) throw failure;
}
