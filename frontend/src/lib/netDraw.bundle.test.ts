/**
 * The library build of the net drawing module, built here from
 * `vite.lib.config.ts` into a temporary directory: both files stand alone
 * (nothing from Svelte, nothing imported or required), the ES module
 * exports the two functions, and the IIFE defines `petriNetView` when run
 * as a classic script in a fresh context.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FRONTEND = fileURLToPath(new URL('../..', import.meta.url));
const FILES = ['net-view.js', 'net-view.iife.js'];

/** Every module specifier the code names, by static or dynamic import,
 *  re-export or require. */
function specifiers(code: string): string[] {
	const patterns = [
		/\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"']+)["']/g,
		/\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
		/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
	];
	return patterns.flatMap((pattern) => Array.from(code.matchAll(pattern), (match) => match[1]));
}

describe('the net drawing module library build', () => {
	let outDir = '';
	const code: Record<string, string> = {};

	beforeAll(async () => {
		outDir = mkdtempSync(join(tmpdir(), 'net-view-'));
		await build({
			configFile: join(FRONTEND, 'vite.lib.config.ts'),
			logLevel: 'silent',
			build: { outDir, emptyOutDir: true },
		});
		for (const name of FILES) code[name] = readFileSync(join(outDir, name), 'utf8');
	}, 120_000);

	afterAll(() => {
		if (outDir) rmSync(outDir, { recursive: true, force: true });
	});

	it('finds the specifier patterns it looks for', () => {
		expect(specifiers(`import{a as b}from"svelte/store";import "x";export*from"./y";require('z');import('w')`)).toEqual([
			'svelte/store',
			'x',
			'./y',
			'w',
			'z',
		]);
	});

	it.each(FILES)('%s names nothing from Svelte', (name) => {
		expect(code[name]).not.toMatch(/svelte/i);
	});

	it.each(FILES)('%s imports and requires nothing: every dependency is inlined', (name) => {
		expect(specifiers(code[name])).toEqual([]);
	});

	it.each(FILES)('%s is minified, without a source map', (name) => {
		expect(code[name].split('\n').filter((line) => line.trim() !== '').length).toBeLessThanOrEqual(2);
		expect(code[name]).not.toMatch(/sourceMappingURL/);
	});

	it('exports drawNet and releaseNet from the ES module', async () => {
		const mod = await import(/* @vite-ignore */ pathToFileURL(join(outDir, 'net-view.js')).href);
		expect(Object.keys(mod).sort()).toEqual(['drawNet', 'releaseNet']);
		expect(typeof mod.drawNet).toBe('function');
		expect(typeof mod.releaseNet).toBe('function');
	});

	it('defines petriNetView with both functions when the IIFE runs as a classic script', () => {
		const context = vm.createContext({});
		vm.runInContext(code['net-view.iife.js'], context);
		const view = (context as { petriNetView?: Record<string, unknown> }).petriNetView;
		expect(view).toBeDefined();
		expect(typeof view?.drawNet).toBe('function');
		expect(typeof view?.releaseNet).toBe('function');
	});
});
