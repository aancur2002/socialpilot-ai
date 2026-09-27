import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { isProduction } from '@socialpilot/config';
import { AppError, getInfra, MAX_UPLOAD_BYTES, validateSession } from '@socialpilot/core';
import { isSocialApiError } from '@socialpilot/social';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE } from './http';
import { registerRoutes } from './routes';

export async function buildServer(): Promise<FastifyInstance> {
  const { env, logger, redis } = getInfra();
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  // Validation is done with zod inside handlers; JSON schemas are attached for OpenAPI docs only.
  app.setValidatorCompiler(() => () => true);

  // Keep the raw body for webhook signature verification (HMAC over exact bytes).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (buf.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(buf.toString('utf8')));
    } catch {
      done(new AppError('BAD_REQUEST', 'Malformed JSON body'), undefined);
    }
  });

  const PUBLIC_PREFIX = '/api/v1/public/';
  const allowedOrigins = new Set([env.APP_URL, ...env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)]);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  // Public lead endpoints (embedded forms, lead API) are called from customers' own websites:
  // any origin, never with cookies. Everything else: our app only, with cookies.
  await app.register(cors, () => (req: { url?: string }, cb: (err: Error | null, options: Record<string, unknown>) => void) => {
    if (req.url?.startsWith(PUBLIC_PREFIX)) return cb(null, { origin: '*', credentials: false, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['content-type', 'authorization'] });
    cb(null, { origin: (origin: string | undefined, done: (e: Error | null, ok: boolean) => void) => done(null, !origin || allowedOrigins.has(origin)), credentials: true });
  });
  await app.register(cookie, { secret: env.JWT_SECRET });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });
  await app.register(rateLimit, {
    global: true,
    max: env.API_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'sp-api-rl:',
    allowList: (req) => req.url.startsWith('/health') || req.url.startsWith('/ready'),
    skipOnError: true,
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'SocialPilot AI API', version: '0.1.0', description: 'Multi-tenant social media management API. Authenticate with the session cookie; select an organization with the X-Organization-Id header.' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } } },
      security: [{ session: [] }],
    },
  });
  if (!isProduction(env)) await app.register(swaggerUi, { routePrefix: '/docs' });

  // Session → request.user
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      req.sessionToken = token;
      req.user = (await validateSession(token)) ?? undefined;
    }
  });

  // CSRF: cookie-authenticated, state-changing requests must come from an allowed Origin.
  // (Session cookies are also SameSite=Lax; webhooks and OAuth redirects are exempt.)
  app.addHook('preHandler', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.url.startsWith('/webhooks/')) return;
    // Public endpoints authenticate with a form key or API key, never the session cookie.
    if (req.url.startsWith(PUBLIC_PREFIX)) return;
    if (!req.cookies[SESSION_COOKIE]) return;
    const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
    const self = `${req.protocol}://${req.headers.host}`;
    if (!origin || (!allowedOrigins.has(origin) && origin !== self)) {
      throw new AppError('FORBIDDEN', 'Cross-site request blocked');
    }
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      if (error.status >= 500) req.log.error({ err: error }, error.message);
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details, requestId: req.id } });
    }
    if (isSocialApiError(error)) {
      req.log.warn({ platform: error.platform, code: error.code }, error.message);
      const status = error.code === 'UNSUPPORTED' ? 400 : error.code === 'NOT_CONFIGURED' ? 501 : error.code === 'RATE_LIMITED' ? 429 : 502;
      return reply.status(status).send({ error: { code: `SOCIAL_${error.code}`, message: error.message, details: { platform: error.platform, requiresReauth: error.requiresReauth }, requestId: req.id } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', message: (error as Error).message, requestId: req.id } });
    }
    req.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong', requestId: req.id } });
  });

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url.split('?')[0]} not found`, requestId: req.id } }));

  await registerRoutes(app);
  return app;
}
