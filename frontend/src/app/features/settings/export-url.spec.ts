import { exportFileName, exportUrl } from './export-url';

describe('exportUrl', () => {
  it('is the plain path when the range is open', () => {
    expect(exportUrl('spendings', {})).toBe('/api/export/spendings.csv');
    expect(exportUrl('incomes', {})).toBe('/api/export/incomes.csv');
    expect(exportUrl('savings', {})).toBe('/api/export/savings.csv');
  });

  it('adds only the bounds that are set', () => {
    expect(exportUrl('spendings', { from: '2026-01-01' })).toBe(
      '/api/export/spendings.csv?from=2026-01-01',
    );
    expect(exportUrl('incomes', { to: '2026-03-31' })).toBe('/api/export/incomes.csv?to=2026-03-31');
    expect(exportUrl('savings', { from: '2026-01-01', to: '2026-03-31' })).toBe(
      '/api/export/savings.csv?from=2026-01-01&to=2026-03-31',
    );
  });

  it('never sends an empty bound, which the API would refuse', () => {
    expect(exportUrl('spendings', { from: '', to: undefined })).toBe('/api/export/spendings.csv');
  });

  it('encodes the values', () => {
    expect(exportUrl('spendings', { from: '2026-01-01&to=x' })).toBe(
      '/api/export/spendings.csv?from=2026-01-01%26to%3Dx',
    );
  });
});

describe('exportFileName', () => {
  it('is the name the API gives the file', () => {
    expect(exportFileName('spendings', {})).toBe('wallet-spendings-all.csv');
    expect(exportFileName('incomes', { from: '2026-01-01' })).toBe('wallet-incomes-from-2026-01-01.csv');
    expect(exportFileName('savings', { to: '2026-03-31' })).toBe('wallet-savings-until-2026-03-31.csv');
    expect(exportFileName('spendings', { from: '2026-01-01', to: '2026-03-31' })).toBe(
      'wallet-spendings-2026-01-01_to_2026-03-31.csv',
    );
  });
});
