import {
  EXPORT_CONTENT_TYPE,
  type ExportKind,
  type ExportQuery,
  exportFilename,
  exportQuerySchema,
} from '@wallet/shared';
import { type Response, Router } from 'express';
import type { AppDeps } from '../../app';
import { exportIncomes, exportSavings, exportSpendings } from './export.service';

/** The headers of every export (see the notes at the top of shared/src/export.ts), then the file. */
function sendCsv(res: Response, kind: ExportKind, query: ExportQuery, csv: string): void {
  res
    .status(200)
    .set({
      'Content-Type': EXPORT_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${exportFilename(kind, query)}"`,
      'Cache-Control': 'no-store',
    })
    .send(csv);
}

export function exportRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/spendings.csv', (req, res) => {
    // Express 5: `req.query` is a read-only getter, so parse it into a local.
    const query = exportQuerySchema.parse(req.query);
    sendCsv(res, 'spendings', query, exportSpendings(deps, query));
  });

  router.get('/incomes.csv', (req, res) => {
    const query = exportQuerySchema.parse(req.query);
    sendCsv(res, 'incomes', query, exportIncomes(deps, query));
  });

  router.get('/savings.csv', (req, res) => {
    const query = exportQuerySchema.parse(req.query);
    sendCsv(res, 'savings', query, exportSavings(deps, query));
  });

  return router;
}
