import type { MonthKey } from '@wallet/shared/month';
import { formatMonth } from '../format';

/** A sentence about the month a form applies from. A warning is about changing a closed month. */
export interface MonthNote {
  tone: 'info' | 'warning';
  text: string;
}

/**
 * The month a new budget or subscription starts in unless the person chooses another: the month the
 * page shows, but never a closed one, so a closed month does not change by accident (docs/DOMAIN.md,
 * "Versioned values"). Backdating stays possible, and it is the person's explicit choice.
 */
export function defaultStartMonth(selected: MonthKey, current: MonthKey): MonthKey {
  return selected < current ? current : selected;
}

/**
 * What choosing `chosen` as the month a new amount or price applies from means, next to the field.
 * The default is the current month. A later month schedules the change. An earlier month is already
 * closed, so the note says in plain words that it changes that month's figures and what is due to
 * savings: backdating is allowed, but never silent.
 */
export function appliesFromNote(options: {
  chosen: MonthKey;
  current: MonthKey;
  locale: string;
  /** What is being changed: "amount" (a budget) or "price" (a subscription). */
  noun: 'amount' | 'price';
}): MonthNote {
  const { chosen, current, locale, noun } = options;
  const label = formatMonth(chosen, locale);

  if (chosen < current) {
    return {
      tone: 'warning',
      text: `Backdating: ${label} is already closed. Changing its ${noun} also changes that month's figures and what is due to savings.`,
    };
  }
  if (chosen === current) {
    return {
      tone: 'info',
      text: `The new ${noun} applies from ${label} on. Earlier months keep their ${noun}s.`,
    };
  }
  return {
    tone: 'info',
    text: `Scheduled: the new ${noun} applies from ${label} on. ${formatMonth(current, locale)} and earlier months keep their ${noun}s.`,
  };
}

/** The same for the first month of something new: a budget or a subscription. */
export function startsNote(options: {
  chosen: MonthKey;
  current: MonthKey;
  locale: string;
  subject: 'budget' | 'subscription';
}): MonthNote {
  const { chosen, current, locale, subject } = options;
  const label = formatMonth(chosen, locale);

  if (chosen < current) {
    return {
      tone: 'warning',
      text: `Backdating: ${label} is already closed. A ${subject} that starts then also changes that month's figures and what is due to savings.`,
    };
  }
  return {
    tone: 'info',
    text: `The ${subject} starts in ${label}. Earlier months are not affected.`,
  };
}
