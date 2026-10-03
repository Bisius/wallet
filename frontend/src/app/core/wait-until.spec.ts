import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { settle } from '../../testing/harness';
import { waitUntil } from './wait-until';

describe('waitUntil', () => {
  it('resolves at once when there is a value already', async () => {
    const injector = TestBed.inject(Injector);
    await expect(waitUntil(injector, () => 'ready')).resolves.toBe('ready');
  });

  it('resolves with the first value that is not undefined, as signals change', async () => {
    const injector = TestBed.inject(Injector);
    const state = signal<'loading' | 'done'>('loading');
    let result: string | undefined;
    void waitUntil(injector, () => (state() === 'loading' ? undefined : state())).then(
      (value) => (result = value),
    );

    await settle();
    expect(result).toBeUndefined();

    state.set('done');
    await settle();
    expect(result).toBe('done');
  });

  it('does not resolve with undefined, but does with falsy values that are real answers', async () => {
    const injector = TestBed.inject(Injector);
    await expect(waitUntil(injector, () => 0)).resolves.toBe(0);
    await expect(waitUntil(injector, () => '')).resolves.toBe('');
    await expect(waitUntil(injector, () => false)).resolves.toBe(false);
  });

  it('can serve many waiters at once, each cleaning up after itself', async () => {
    const injector = TestBed.inject(Injector);
    const value = signal<number | undefined>(undefined);
    const waiters = Array.from({ length: 20 }, () => waitUntil(injector, () => value()));

    value.set(7);
    await settle();

    await expect(Promise.all(waiters)).resolves.toEqual(Array(20).fill(7));
    // A later change wakes nobody and throws nothing.
    value.set(8);
    await settle();
  });
});
