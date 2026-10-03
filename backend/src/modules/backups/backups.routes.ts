import { backupNameParamsSchema } from '@wallet/shared';
import { type NextFunction, type Request, type Response, Router } from 'express';
import { HttpError } from '../../lib/errors';
import { pipeline } from 'node:stream/promises';
import { type BackupDeps, createBackup, listBackups, openBackup } from './backups.service';

/**
 * Backups of the database file. Mounted before onboarding is required: a copy of the data is just
 * as useful (and as safe) while the settings do not exist yet.
 */
export function backupRoutes(deps: BackupDeps): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json(await listBackups(deps));
  });

  router.post('/', async (_req, res) => {
    res.status(201).json(await createBackup(deps));
  });

  router.get('/:name', async (req, res) => {
    const { name } = backupNameParamsSchema.parse(req.params);
    const file = await openBackup(deps, name);
    // The name was validated and found in the directory listing: it is a plain ASCII file name.
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': String(file.sizeBytes),
      'Cache-Control': 'no-store',
    });
    try {
      // The stream closes the handle when it ends or fails.
      await pipeline(file.handle.createReadStream(), res);
    } catch (error) {
      await file.handle.close().catch(() => undefined);
      // Nothing can be reported once the body has started: a short download is how the client finds out.
      if (!res.headersSent) throw error;
      res.destroy();
    }
  });

  // A malformed percent escape in the path (`/api/backups/%E0%A4%A`) fails inside Express's own
  // decoding of the parameter, before the handler and as a plain URIError. It is a malformed name
  // like any other: the same 400 at `name` that the schema gives.
  router.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
    if (!(error instanceof URIError)) return next(error);
    next(
      new HttpError(400, 'validation_error', 'Invalid request', [
        { path: 'name', message: 'Expected a backup file name like wallet-20261003-142530.db' },
      ]),
    );
  });

  return router;
}
