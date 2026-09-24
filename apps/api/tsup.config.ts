import { defineConfig } from 'tsup';

// Bundles workspace packages into a single Node ESM build; npm deps stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@socialpilot\//],
});
