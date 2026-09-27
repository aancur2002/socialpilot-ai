import { defineConfig } from 'tsup';

// Bundles our workspace packages (TypeScript sources) into one Node ESM build.
// Every other bare import stays external and is resolved from node_modules at
// runtime — bundling CJS dependencies such as @prisma/client into ESM breaks them.
export default defineConfig({
  entry: ['src/main.ts', 'src/admin-cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@socialpilot\//],
  external: [/^(?!@socialpilot\/)[^./]/],
});
