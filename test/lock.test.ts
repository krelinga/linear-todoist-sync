import { describe, expect, it } from 'vitest';
import { Lock } from '../src/lock.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Lock', () => {
  it('runs a single task and returns its result', async () => {
    const lock = new Lock();
    await expect(lock.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('serializes overlapping tasks in call order', async () => {
    const lock = new Lock();
    const order: string[] = [];
    const first = deferred<void>();

    const a = lock.run(async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    const b = lock.run(async () => {
      order.push('b-start');
      order.push('b-end');
    });

    // b must not have started yet: a is still awaiting `first`.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a-start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('keeps the queue alive after a task rejects', async () => {
    const lock = new Lock();
    await expect(
      lock.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(lock.run(async () => 'still works')).resolves.toBe('still works');
  });
});
