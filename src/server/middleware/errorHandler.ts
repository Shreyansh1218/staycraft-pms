import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { sanitizeErrorForLog } from '../config.js';
import { AppError, formatZodError, normalizeDatabaseError } from '../errors.js';

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    const { message, fieldErrors } = formatZodError(err);
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message,
        fieldErrors,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err && typeof err === 'object') {
    const bodyErr = err as { type?: string; status?: number };
    if (bodyErr.type === 'entity.too.large' || bodyErr.status === 413) {
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request payload exceeds maximum allowed size.',
        },
      });
      return;
    }
    if (bodyErr.type === 'entity.parse.failed' || (err instanceof SyntaxError && bodyErr.status === 400)) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Malformed JSON request payload.',
        },
      });
      return;
    }
  }

  const dbAppErr = normalizeDatabaseError(err);
  if (dbAppErr) {
    res.status(dbAppErr.statusCode).json({
      error: {
        code: dbAppErr.code,
        message: dbAppErr.message,
        ...(dbAppErr.details ? { details: dbAppErr.details } : {}),
      },
    });
    return;
  }

  console.error('[Unhandled Server Error]', sanitizeErrorForLog(err));
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred. Please try again.',
    },
  });
}
