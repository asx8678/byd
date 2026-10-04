// Builds the generator prototype: `--mode node` for the headless checks, otherwise the in-page demo.
//   npx vite build --config prototype/generator/vite.config.mjs --mode node && node prototype/generator/dist/headless.mjs
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
export default ({ mode }) => ({
  logLevel: 'warn', publicDir: false,
  build: {
    outDir: `${here}dist`, emptyOutDir: false, minify: false, target: 'es2022',
    lib: mode === 'node'
      ? { entry: `${here}src/headless.ts`, formats: ['es'], fileName: () => 'headless.mjs' }
      : { entry: `${here}src/demo.ts`, formats: ['iife'], name: 'GenDemo', fileName: () => 'demo.js' },
  },
});
