/**
 * A simple in-process async mutex (§5.3): the poll loop and the daily digest job share one
 * instance so they never run concurrently, since both can write to the same Linear attachment.
 */
export class Lock {
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => fn());
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
