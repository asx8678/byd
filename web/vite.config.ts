import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// `vite build` makes the installable web app (manifest, icons, service worker).
// `vite build --mode artifact` makes a page for the claude.ai artifact viewer, which allows neither a manifest nor a service worker.
const dropPwaTags = (): Plugin => ({
  name: 'drop-pwa-tags',
  transformIndexHtml: html => html.replace(/^.*data-pwa.*\n/gm, ''),
});

// Writes the list of built files and a version hash into dist/sw.js, so the first visit caches the whole app.
const precache = (): Plugin => {
  let outDir = 'dist';
  return {
    name: 'precache-list',
    apply: 'build',
    configResolved: c => { outDir = c.build.outDir; },
    closeBundle: () => {
      const files: string[] = [];
      const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else files.push(relative(outDir, f).split('\\').join('/')); } };
      walk(outDir);
      const list = files.filter(f => f !== 'sw.js').sort().map(f => './' + f);
      const sw = join(outDir, 'sw.js'), template = readFileSync(sw, 'utf8');
      const hash = createHash('sha256').update(template); for (const f of list) hash.update(f).update(readFileSync(join(outDir, f)));
      writeFileSync(sw, template.replace("'__VERSION__'", JSON.stringify('atto2-' + hash.digest('hex').slice(0, 12))).replace('__PRECACHE__', JSON.stringify(list)));
    },
  };
};

export default defineConfig(({ mode }) => ({
  base: './',   // works from any folder, e.g. GitHub Pages under /byd/
  plugins: mode === 'artifact' ? [dropPwaTags()] : [precache()],
  build: { target: 'es2022', assetsInlineLimit: 0 },
}));
