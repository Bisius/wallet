import { idParamsSchema, tagCreateSchema, tagUpdateSchema } from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { createTag, deleteTag, listTags, updateTag } from './tags.service';

export function tagRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listTags(deps));
  });

  router.post('/', (req, res) => {
    const input = tagCreateSchema.parse(req.body);
    res.status(201).json(createTag(deps, input));
  });

  router.patch('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = tagUpdateSchema.parse(req.body);
    res.json(updateTag(deps, id, input));
  });

  router.delete('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    deleteTag(deps, id);
    res.status(204).end();
  });

  return router;
}
