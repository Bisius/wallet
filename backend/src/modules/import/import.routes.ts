import {
  idParamsSchema,
  importCommitSchema,
  importParseSchema,
  importPreviewSchema,
  importProfileSchema,
} from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { commitImport, parseImportFile, previewImport } from './import.service';
import {
  createProfile,
  deleteProfile,
  listProfiles,
  replaceProfile,
} from './import.profiles.service';

export function importRoutes(deps: AppDeps): Router {
  const router = Router();

  router.post('/parse', (req, res) => {
    res.json(parseImportFile(deps, importParseSchema.parse(req.body)));
  });

  router.post('/preview', (req, res) => {
    res.json(previewImport(deps, importPreviewSchema.parse(req.body)));
  });

  router.post('/commit', (req, res) => {
    res.status(201).json(commitImport(deps, importCommitSchema.parse(req.body)));
  });

  router.get('/profiles', (_req, res) => {
    res.json(listProfiles(deps));
  });

  router.post('/profiles', (req, res) => {
    res.status(201).json(createProfile(deps, importProfileSchema.parse(req.body)));
  });

  router.put('/profiles/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json(replaceProfile(deps, id, importProfileSchema.parse(req.body)));
  });

  router.delete('/profiles/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    deleteProfile(deps, id);
    res.status(204).end();
  });

  return router;
}
