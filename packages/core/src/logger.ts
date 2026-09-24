import pino, { type Logger } from 'pino';

/**
 * Structured logger. Anything that could carry a credential is redacted by path,
 * and adapters/services never pass raw tokens to log calls in the first place.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'accessTokenEnc',
  '*.accessTokenEnc',
  'refreshTokenEnc',
  '*.refreshTokenEnc',
  'credentials',
  '*.credentials',
  'secret',
  '*.secret',
  'clientSecret',
  '*.clientSecret',
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'apiKey',
  '*.apiKey',
];

let root: Logger | undefined;

export function getLogger(): Logger {
  if (!root) {
    root = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { service: process.env.SERVICE_NAME ?? 'socialpilot' },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return root;
}

export type { Logger };

/** Times an operation and logs {operation, duration, success, error} with the given context. */
export async function withOperationLog<T>(
  log: Logger,
  operation: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    log.info({ ...fields, operation, durationMs: Math.round(performance.now() - started), success: true }, operation);
    return result;
  } catch (error) {
    log.warn(
      { ...fields, operation, durationMs: Math.round(performance.now() - started), success: false, error: error instanceof Error ? error.message : String(error) },
      `${operation} failed`,
    );
    throw error;
  }
}
