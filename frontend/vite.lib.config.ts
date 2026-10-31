/**
 * The library build of the net drawing module (`src/lib/netDraw.ts`), apart
 * from the app's: no SvelteKit plugin, every dependency inlined, two files
 * in `dist-lib/`. `net-view.js` is an ES module, for the app. `net-view.iife.js`
 * puts `petriNetView.drawNet` and `petriNetView.releaseNet` on the global
 * object, for a page whose policy allows script only by nonce, where a
 * classic `<script nonce src>` is the way in: the public tier vendors it.
 *
 *     npm run build:lib    # or `just build-lib` at the repository root
 */

import { fileURLToPath } from 'node:url';
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Vite keeps the whitespace of an ES library build, so that a consumer's
 *  bundler can still read its pure annotations; this module is taken
 *  whole, so its ES file is minified as fully as the IIFE. */
function minifyEsOutput(): Plugin {
	return {
		name: 'net-view-minify-es',
		apply: 'build',
		async generateBundle(output, bundle) {
			if (output.format !== 'es') return;
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== 'chunk') continue;
				const minified = await transformWithEsbuild(chunk.code, chunk.fileName, {
					loader: 'js',
					format: 'esm',
					minify: true,
					legalComments: 'none',
				});
				chunk.code = minified.code;
			}
		},
	};
}

export default defineConfig({
	root,
	publicDir: false,
	resolve: {
		alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) },
	},
	plugins: [minifyEsOutput()],
	build: {
		outDir: 'dist-lib',
		emptyOutDir: true,
		minify: 'esbuild',
		sourcemap: false,
		lib: {
			entry: 'src/lib/netDraw.ts',
			formats: ['es', 'iife'],
			name: 'petriNetView',
			fileName: (format) => (format === 'es' ? 'net-view.js' : 'net-view.iife.js'),
		},
	},
});
