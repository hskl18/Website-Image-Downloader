export class JobLimiter {
  private activeJobs = 0;

  constructor(private readonly maxConcurrentJobs: number) {}

  tryAcquire() {
    if (this.activeJobs >= this.maxConcurrentJobs) {
      return null;
    }

    this.activeJobs += 1;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.activeJobs -= 1;
    };
  }
}
