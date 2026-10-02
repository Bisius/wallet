import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // The shared workspace package ships TypeScript sources, so it must be bundled in.
  noExternal: ['@wallet/shared'],
});
