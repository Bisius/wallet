import type { ApiError } from '@wallet/shared';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let body: ApiError;
  let status: number;

  if (err instanceof ZodError) {
    status = 400;
    body = {
      error: {
        code: 'validation_error',
        message: 'Invalid request',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  } else if (err instanceof HttpError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message, details: err.details } };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { error: { code: 'invalid_json', message: 'Request body is not valid JSON' } };
  } else {
    console.error(err);
    status = 500;
    body = { error: { code: 'internal_error', message: 'Something went wrong' } };
  }

  res.status(status).json(body);
};
