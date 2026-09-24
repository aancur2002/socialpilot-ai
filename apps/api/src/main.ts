import { getEnv } from '@socialpilot/config';
import { closeInfra, getInfra } from '@socialpilot/core';
import { buildServer } from './server';

const env = getEnv();
const app = await buildServer();
const { logger } = getInfra();

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info({ port: env.API_PORT, mockSocial: getInfra().social.mockEnabled, aiProvider: env.AI_PROVIDER }, 'API listening');
} catch (error) {
  logger.fatal({ err: error }, 'API failed to start');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'shutting down API');
    await app.close();
    await closeInfra();
    process.exit(0);
  });
}
