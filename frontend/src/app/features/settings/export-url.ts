import { type ExportKind, type ExportQuery, exportFilename, exportPath } from '@wallet/shared';

/**
 * The address of an export: `/api/export/spendings.csv?from=2026-01-01&to=2026-03-31`. An empty bound
 * is left out (the API reads a missing one as open, and would refuse an empty one). The values are
 * encoded, though a date holds nothing that needs it.
 */
export function exportUrl(kind: ExportKind, range: ExportQuery): string {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const query = params.toString();
  return query === '' ? exportPath(kind) : `${exportPath(kind)}?${query}`;
}

/** The name the API gives the file (`Content-Disposition`), so the link can offer the same one. */
export function exportFileName(kind: ExportKind, range: ExportQuery): string {
  return exportFilename(kind, range);
}
