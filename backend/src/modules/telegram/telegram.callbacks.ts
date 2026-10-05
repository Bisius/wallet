/**
 * The `callback_data` of the bot's buttons: what they carry, how it is written, and how it is read
 * back. Pure. Telegram allows 1 to 64 BYTES, and every format here stays well under that
 * (`LONGEST_CALLBACK_DATA` is the longest one that can exist, and a test pins it).
 *
 * There are two kinds of button.
 *
 * - **Flow buttons** belong to the conversation in progress (`/spending`, `/income`, quick entry),
 *   and carry its short id: `f:<flowId>:<action>`. A tap whose flow is finished, replaced or expired
 *   is stale (docs/DOMAIN.md, "Flow state").
 *
 *       f:<id>:b:<budgetId>   a budget          f:<id>:x    Cancel
 *       f:<id>:s              Skip the note     f:<id>:e    Earlier...
 *       f:<id>:d:<date>       a day (explicit)  f:<id>:ok   Save, in a closed month
 *       f:<id>:od             Other date
 *
 * - **Row buttons** act on a STORED spending (`s`) or income (`i`) and carry its id, so they work
 *   after a restart and never belong to a flow. They also carry `<fp>`, the row's FINGERPRINT: its
 *   `createdAt` in milliseconds, in base 36 (`fingerprintOf`, telegram.entries.ts). The id alone is
 *   not enough: AUTOINCREMENT never reuses an id while the database lives, but restoring a backup
 *   brings back `sqlite_sequence`, so an old button of the chat could name an id that a NEW row has
 *   now. `createdAt` is never edited, so a row that was edited on the web keeps its fingerprint, and
 *   a different row under the same id has another one (it was created at another time). A button
 *   whose fingerprint does not match the stored row is answered "Already removed." and acts on nothing.
 *
 *       u:<k>:<id>:<fp>                    Undo                     (asks first in a closed month)
 *       d:<k>:<id>:<fp>                    ask "Delete ...?"        (/recent)
 *       d:<k>:<id>:<fp>:y<named>           delete now               (Delete, Remove)
 *       c:<k>:<id>:<fp>                    Change date: the days
 *       c:<k>:<id>:<fp>:<date>             move it to that day      (asks first when a closed month is touched)
 *       c:<k>:<id>:<fp>:<date>:y<named>    move it, confirmed
 *       r:<k>:<id>:<fp>                    back to the confirmation (Back, Keep)
 *       k                                  Keep: dismiss a question
 *
 *   `y<named>` is the confirmation of a question, and `<named>` the closed months that question
 *   NAMED, as `YYYYMM` joined by `+` (none: `y`). A confirmed tap recomputes the closed months at
 *   the moment of the tap and asks again when there is one the question did not name (the month
 *   closed meanwhile, or the row was moved into one on the web).
 */
import { type IsoDate, type MonthKey, isMonthKey, isoDateSchema } from '@wallet/shared';

/** Telegram's limit for `callback_data`, in bytes. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/** `s`: a spending, `i`: an income. */
export type RowKind = 's' | 'i';

export type FlowAction =
  | { type: 'budget'; budgetId: number }
  | { type: 'cancel' }
  | { type: 'skip' }
  | { type: 'date'; date: IsoDate }
  | { type: 'earlier' }
  | { type: 'confirm' }
  | { type: 'other' };

/** A stored row as a button names it: kind, id, and the fingerprint that proves it is that row. */
export interface RowRef {
  kind: RowKind;
  id: number;
  /** `fingerprintOf(createdAt)`: base 36, 1 to 9 characters. */
  fp: string;
}

export type RowAction =
  | ({ type: 'undo' } & RowRef)
  /** `confirmed`: the closed months the question named; undefined: ask first. */
  | ({ type: 'delete'; confirmed?: readonly MonthKey[] } & RowRef)
  | ({ type: 'change'; date?: IsoDate; confirmed?: readonly MonthKey[] } & RowRef)
  | ({ type: 'back' } & RowRef)
  | { type: 'keep' };

export type Callback =
  { scope: 'flow'; flowId: string; action: FlowAction } | { scope: 'row'; action: RowAction };

const FLOW_ID = /^[0-9a-z]{3,8}$/;
const ID = /^[1-9]\d{0,15}$/;
const FINGERPRINT = /^[0-9a-z]{1,9}$/;
/** `y`, then the named months as `YYYYMM` joined by `+` (none: just `y`). */
const CONFIRMED = /^y(\d{6}(?:\+\d{6})*)?$/;

// --- Writing ----------------------------------------------------------------------------------

export function flowData(flowId: string, action: FlowAction): string {
  switch (action.type) {
    case 'budget':
      return `f:${flowId}:b:${action.budgetId}`;
    case 'cancel':
      return `f:${flowId}:x`;
    case 'skip':
      return `f:${flowId}:s`;
    case 'date':
      return `f:${flowId}:d:${action.date}`;
    case 'earlier':
      return `f:${flowId}:e`;
    case 'confirm':
      return `f:${flowId}:ok`;
    case 'other':
      return `f:${flowId}:od`;
  }
}

/** `y202609+202610`: a confirmation, and the closed months the question named. */
const confirmedToken = (named: readonly MonthKey[]): string =>
  `y${named.map((month) => month.replace('-', '')).join('+')}`;

export function rowData(action: RowAction): string {
  if (action.type === 'keep') return 'k';
  const base = `${action.kind}:${action.id}:${action.fp}`;
  switch (action.type) {
    case 'undo':
      return `u:${base}`;
    case 'delete':
      return `d:${base}${action.confirmed === undefined ? '' : `:${confirmedToken(action.confirmed)}`}`;
    case 'change':
      return (
        `c:${base}` +
        (action.date === undefined
          ? ''
          : `:${action.date}${action.confirmed === undefined ? '' : `:${confirmedToken(action.confirmed)}`}`)
      );
    case 'back':
      return `r:${base}`;
  }
}

/** The data of a tap, whichever kind of button. */
export const callbackData = (callback: Callback): string =>
  callback.scope === 'flow' ? flowData(callback.flowId, callback.action) : rowData(callback.action);

// --- Reading ----------------------------------------------------------------------------------

const isRowKind = (value: string | undefined): value is RowKind => value === 's' || value === 'i';
/** A positive integer id, written with no leading zero and small enough to be exact; null otherwise. */
const idOf = (value: string | undefined): number | null => {
  if (value === undefined || !ID.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
};
/** A real calendar date (`2026-02-30` is none): what a button of a flow may carry. */
const isDate = (value: string | undefined): value is string =>
  value !== undefined && isoDateSchema.safeParse(value).success;

function readFlow(parts: string[]): Callback | null {
  const [, flowId, code, arg, extra] = parts;
  if (flowId === undefined || !FLOW_ID.test(flowId) || extra !== undefined) return null;
  const flow = (action: FlowAction): Callback => ({ scope: 'flow', flowId, action });
  switch (code) {
    case 'b': {
      const budgetId = idOf(arg);
      return budgetId === null ? null : flow({ type: 'budget', budgetId });
    }
    case 'd':
      return isDate(arg) ? flow({ type: 'date', date: arg }) : null;
    case 'x':
    case 's':
    case 'e':
    case 'ok':
    case 'od': {
      if (arg !== undefined) return null;
      const type = { x: 'cancel', s: 'skip', e: 'earlier', ok: 'confirm', od: 'other' } as const;
      return flow({ type: type[code] });
    }
    default:
      return null;
  }
}

/** The months a `y...` token names, or null when `token` is no confirmation. */
function namedMonths(token: string | undefined): MonthKey[] | null {
  const match = token === undefined ? null : CONFIRMED.exec(token);
  if (!match) return null;
  const months = (match[1] ?? '').split('+').filter((part) => part !== '');
  const keys = months.map((part) => `${part.slice(0, 4)}-${part.slice(4)}`);
  return keys.every((key) => isMonthKey(key)) ? keys : null;
}

function readRow(parts: string[]): Callback | null {
  const [verb, kind, id, fp, arg, flag, extra] = parts;
  const row = (action: RowAction): Callback => ({ scope: 'row', action });
  if (verb === 'k') return parts.length === 1 ? row({ type: 'keep' }) : null;
  const rowId = idOf(id);
  if (
    !isRowKind(kind) ||
    rowId === null ||
    fp === undefined ||
    !FINGERPRINT.test(fp) ||
    extra !== undefined
  ) {
    return null;
  }
  const ref: RowRef = { kind, id: rowId, fp };
  switch (verb) {
    case 'u':
      return parts.length === 4 ? row({ type: 'undo', ...ref }) : null;
    case 'r':
      return parts.length === 4 ? row({ type: 'back', ...ref }) : null;
    case 'd': {
      if (parts.length === 4) return row({ type: 'delete', ...ref });
      const confirmed = parts.length === 5 ? namedMonths(arg) : null;
      return confirmed === null ? null : row({ type: 'delete', ...ref, confirmed });
    }
    case 'c': {
      if (parts.length === 4) return row({ type: 'change', ...ref });
      if (!isDate(arg)) return null;
      if (parts.length === 5) return row({ type: 'change', ...ref, date: arg });
      const confirmed = parts.length === 6 ? namedMonths(flag) : null;
      return confirmed === null ? null : row({ type: 'change', ...ref, date: arg, confirmed });
    }
    default:
      return null;
  }
}

/**
 * What a tap carries, or null when `data` is none of the formats above (an old button, a button of
 * another version, a made-up one): the caller treats it as stale.
 */
export function readCallback(data: string): Callback | null {
  if (data.length === 0 || new TextEncoder().encode(data).length > CALLBACK_DATA_MAX_BYTES) {
    return null;
  }
  const parts = data.split(':');
  return parts[0] === 'f' ? readFlow(parts) : readRow(parts);
}

/**
 * The longest `callback_data` any button can have: a 16-digit id, the longest flow id, the longest
 * fingerprint (9 characters), a date, and a confirmation that names two months.
 */
export const LONGEST_CALLBACK_DATA: string = [
  flowData('zzzzzzzz', { type: 'budget', budgetId: 9_007_199_254_740_991 }),
  flowData('zzzzzzzz', { type: 'date', date: '9999-12-31' }),
  rowData({
    type: 'change',
    kind: 's',
    id: 9_007_199_254_740_991,
    fp: 'zzzzzzzzz',
    date: '9999-12-31',
    confirmed: ['9999-11', '9999-12'],
  }),
  rowData({
    type: 'delete',
    kind: 's',
    id: 9_007_199_254_740_991,
    fp: 'zzzzzzzzz',
    confirmed: ['9999-11', '9999-12'],
  }),
].reduce((longest, data) => (data.length > longest.length ? data : longest));
