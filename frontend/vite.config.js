import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto'; import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'; import { join, relative } from 'node:path';

// Stamps dist/sw.js with a content-derived version and the list of built files to precache.
function serviceWorkerManifest() {
  let outDir = 'dist';
  const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  return {
    name: 'sw-precache-manifest',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    closeBundle() {
      const files = walk(outDir).map((p) => relative(outDir, p).split('\\').join('/')).filter((f) => f !== 'sw.js' && !f.endsWith('.map')).sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const swPath = join(outDir, 'sw.js');
      writeFileSync(swPath, readFileSync(swPath, 'utf8').replace("BUILD_ID = '__BUILD_ID__'", `BUILD_ID = '${hash.digest('hex').slice(0, 12)}'`).replace('/*__PRECACHE__*/[]', JSON.stringify(files)));
    },
  };
}
export default defineConfig({ plugins: [react(), serviceWorkerManifest()] });
