/**
 * The notification preferences as the notifications read them: the saved row, or the defaults while
 * none was saved. It is the same read as `getTelegramNotificationSettings` in `telegram.service.ts`
 * (which `GET /api/telegram` uses), kept here because `telegram.notifications.ts` must not import the
 * service: the service imports `recordAlertBaseline` from it, and that cycle would make a mock of one
 * of them (the tests of the routes mock `recordAlertBaseline`) apply to the wrong binding.
 * `telegram.notification-preferences.test.ts` checks that the two never disagree.
 */
import {
  DEFAULT_TELEGRAM_NOTIFICATIONS,
  type TelegramNotificationSettingsDto,
} from '@wallet/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { telegramSettings } from '../../db/schema';

/** The table holds one row, with this id. */
const SINGLETON_ID = 1;

export function readNotificationPreferences(db: DbOrTx): TelegramNotificationSettingsDto {
  const row = db.select().from(telegramSettings).where(eq(telegramSettings.id, SINGLETON_ID)).get();
  if (!row) return { ...DEFAULT_TELEGRAM_NOTIFICATIONS };
  return {
    budgetAlerts: row.budgetAlerts,
    renewalYearlyDays: row.renewalYearlyDays,
    renewalMonthlyDays: row.renewalMonthlyDays,
    monthlyRecap: row.monthlyRecap,
    notifyAt: row.notifyAt,
  };
}
