import type {
  CsvDelimiter,
  ImportDateFormat,
  ImportRejectionCode,
  ImportRowErrorCode,
  ImportSignConvention,
} from '@wallet/shared';

/** The delimiters as the select names them. */
export const DELIMITER_LABELS: Record<CsvDelimiter, string> = {
  ',': 'Comma (,)',
  ';': 'Semicolon (;)',
  '\t': 'Tab',
  '|': 'Pipe (|)',
};

/** Each date format with the same day written in it (25 March 2026), so day and month cannot be mixed up. */
export const DATE_FORMAT_EXAMPLES: Record<ImportDateFormat, string> = {
  'YYYY-MM-DD': '2026-03-25',
  'YYYY/MM/DD': '2026/03/25',
  YYYYMMDD: '20260325',
  'DD/MM/YYYY': '25/03/2026',
  'MM/DD/YYYY': '03/25/2026',
  'DD.MM.YYYY': '25.03.2026',
  'DD-MM-YYYY': '25-03-2026',
  'MM-DD-YYYY': '03-25-2026',
};

export const SIGN_LABELS: Record<ImportSignConvention, string> = {
  expenses_negative: 'Expenses are negative (-12.30 is money spent)',
  expenses_positive: 'Expenses are positive (12.30 is money spent)',
};

/** Why a row of the preview cannot be imported, in words. */
export const ROW_ERROR_TEXT: Record<ImportRowErrorCode, string> = {
  invalid_date: "The date can't be read in the chosen date format",
  invalid_amount: "The amount isn't a valid number",
  zero_amount: 'The amount is zero',
  amount_too_large: 'The amount is too large',
  empty_description: 'The description is empty',
  before_start_month: 'The date is before your start month',
};

/** Why a commit refused a row, in words: the row's own codes and four more. */
export const REJECTION_TEXT: Record<ImportRejectionCode, string> = {
  unknown_line: "That line isn't a data row of the file",
  invalid_date: ROW_ERROR_TEXT.invalid_date,
  invalid_amount: ROW_ERROR_TEXT.invalid_amount,
  zero_amount: ROW_ERROR_TEXT.zero_amount,
  amount_too_large: ROW_ERROR_TEXT.amount_too_large,
  empty_description: ROW_ERROR_TEXT.empty_description,
  unknown_budget: "That budget doesn't exist any more",
  before_start_month: ROW_ERROR_TEXT.before_start_month,
  outside_active_months: "The budget isn't active in the month of the date",
  duplicate: 'It was imported already',
};
