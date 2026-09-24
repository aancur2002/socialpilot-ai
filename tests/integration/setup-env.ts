import { TEST_ENV } from './test-env';

for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;
