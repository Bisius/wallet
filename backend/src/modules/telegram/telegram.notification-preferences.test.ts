import { DEFAULT_TELEGRAM_NOTIFICATIONS } from '@wallet/shared';
import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../../db/client';
import { readNotificationPreferences } from './telegram.notification-preferences';
import {
  getTelegramNotificationSettings,
  saveTelegramNotificationSettings,
} from './telegram.service';
import { mutableClock } from '../../testing/helpers';

describe('the preferences as the notifications read them', () => {
  it('are the defaults until a save, as in the service', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    expect(readNotificationPreferences(db)).toEqual(DEFAULT_TELEGRAM_NOTIFICATIONS);
    expect(readNotificationPreferences(db)).toEqual(getTelegramNotificationSettings(db));
  });

  it('are what was saved, exactly as the service reads them', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const clock = mutableClock('2026-03-15T10:00:00Z');
    const saved = {
      budgetAlerts: false,
      renewalYearlyDays: 14,
      renewalMonthlyDays: 0,
      monthlyRecap: false,
      notifyAt: '07:30',
    };
    // Not onboarded: the baseline of an alert switch does nothing, the save still goes through.
    saveTelegramNotificationSettings({ db, clock }, saved);
    expect(readNotificationPreferences(db)).toEqual(saved);
    expect(readNotificationPreferences(db)).toEqual(getTelegramNotificationSettings(db));
  });

  it('is a copy: changing what was read does not change the defaults', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    readNotificationPreferences(db).notifyAt = '23:59';
    expect(readNotificationPreferences(db).notifyAt).toBe('09:00');
  });
});
