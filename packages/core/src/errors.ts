export type AppErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PLAN_LIMIT'
  | 'ACCOUNT_BLOCKED'
  | 'INTEGRATION_ERROR'
  | 'NOT_CONFIGURED'
  | 'INTERNAL';

const STATUS: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PLAN_LIMIT: 402,
  ACCOUNT_BLOCKED: 402,
  INTEGRATION_ERROR: 502,
  NOT_CONFIGURED: 501,
  INTERNAL: 500,
};

/** Application error with a safe, user-facing message. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission to perform this action') => new AppError('FORBIDDEN', message);
export const badRequest = (message: string, details?: unknown) => new AppError('BAD_REQUEST', message, details);
export const conflict = (message: string) => new AppError('CONFLICT', message);
export const validationError = (message: string, details?: unknown) => new AppError('VALIDATION_ERROR', message, details);
