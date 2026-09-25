// Build lib/client.js in the format the dsh 0.1.7 Web host loads:
// one CommonJS-style file wrapped in window.__ModuleLoader__.load({ id, factory }).
// Only the Web platform module table (client/web/src/platform.ts) may be
// required at runtime; everything else is bundled.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { PLATFORM_MODULES } from './platform-modules.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))


await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'warning',
})
