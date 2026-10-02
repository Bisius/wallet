/** Injectable time source so month-boundary logic can be tested deterministically. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}
