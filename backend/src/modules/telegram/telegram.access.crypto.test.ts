import { describe, expect, it, vi } from 'vitest';

// The pairing code must come from the CSPRNG, one `crypto.randomInt` per character: replace it with
// a counter and see exactly which draws the generator makes.
const draws: number[] = [];
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomInt: vi.fn((max: number) => {
    draws.push(max);
    return (draws.length - 1) % max;
  }),
}));

describe('generatePairingCode', () => {
  it('draws each of the 8 characters with crypto.randomInt over the 32-character alphabet', async () => {
    const { PAIRING_CODE_ALPHABET, generatePairingCode } = await import('./telegram.access');
    const code = generatePairingCode();
    expect(draws).toEqual(Array(8).fill(32));
    expect(code).toBe(PAIRING_CODE_ALPHABET.slice(0, 8)); // draw n returned index n
  });
});
