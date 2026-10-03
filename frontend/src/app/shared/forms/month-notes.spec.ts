import { appliesFromNote, defaultStartMonth, startsNote } from './month-notes';

describe('defaultStartMonth', () => {
  it('is the month shown, unless that month is closed', () => {
    expect(defaultStartMonth('2026-10', '2026-10')).toBe('2026-10');
    expect(defaultStartMonth('2026-12', '2026-10')).toBe('2026-12');
    expect(defaultStartMonth('2026-08', '2026-10')).toBe('2026-10');
  });
});

describe('appliesFromNote', () => {
  const note = (chosen: string) =>
    appliesFromNote({ chosen, current: '2026-10', locale: 'en-US', noun: 'amount' });

  it('says the current month is the default: earlier months keep what they had', () => {
    expect(note('2026-10')).toEqual({
      tone: 'info',
      text: 'The new amount applies from October 2026 on. Earlier months keep their amounts.',
    });
  });

  it('calls a later month a schedule', () => {
    expect(note('2027-01')).toEqual({
      tone: 'info',
      text: 'Scheduled: the new amount applies from January 2027 on. October 2026 and earlier months keep their amounts.',
    });
  });

  it('warns about a closed month: it changes that month and what is due to savings', () => {
    expect(note('2026-08')).toEqual({
      tone: 'warning',
      text: "Backdating: August 2026 is already closed. Changing its amount also changes that month's figures and what is due to savings.",
    });
  });

  it('speaks of prices for a subscription', () => {
    expect(
      appliesFromNote({ chosen: '2026-10', current: '2026-10', locale: 'en-US', noun: 'price' })
        .text,
    ).toBe('The new price applies from October 2026 on. Earlier months keep their prices.');
  });

  it('writes the month in the locale', () => {
    expect(
      appliesFromNote({ chosen: '2026-10', current: '2026-10', locale: 'it-IT', noun: 'amount' })
        .text,
    ).toContain('ottobre 2026');
  });
});

describe('startsNote', () => {
  const note = (chosen: string, subject: 'budget' | 'subscription' = 'budget') =>
    startsNote({ chosen, current: '2026-10', locale: 'en-US', subject });

  it('says where it starts, and that earlier months are untouched', () => {
    expect(note('2026-10').text).toBe(
      'The budget starts in October 2026. Earlier months are not affected.',
    );
    expect(note('2027-02', 'subscription').text).toBe(
      'The subscription starts in February 2027. Earlier months are not affected.',
    );
  });

  it('warns about a start in a closed month', () => {
    expect(note('2026-08')).toEqual({
      tone: 'warning',
      text: "Backdating: August 2026 is already closed. A budget that starts then also changes that month's figures and what is due to savings.",
    });
  });
});
