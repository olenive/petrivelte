const THEME_STORAGE_KEY = 'petrivelte-theme';

export type Theme = 'light' | 'dark';

let current: Theme = 'dark';
let listeners: Array<(theme: Theme) => void> = [];

export function getTheme(): Theme {
	return current;
}

export function subscribe(fn: (theme: Theme) => void): () => void {
	listeners.push(fn);
	fn(current);
	return () => {
		listeners = listeners.filter((l) => l !== fn);
	};
}

function notify() {
	for (const fn of listeners) fn(current);
}

function apply() {
	if (typeof document !== 'undefined') {
		document.body.classList.remove('light-theme', 'dark-theme');
		document.body.classList.add(`${current}-theme`);
	}
}

export function loadTheme() {
	if (typeof window === 'undefined') return;
	try {
		const saved = localStorage.getItem(THEME_STORAGE_KEY);
		if (saved === 'light' || saved === 'dark') {
			current = saved;
		} else {
			const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
			current = prefersDark ? 'dark' : 'light';
		}
	} catch (e) {
		console.warn('Failed to load theme:', e);
		current = 'dark';
	}
	apply();
	notify();
}

export function toggleTheme() {
	current = current === 'light' ? 'dark' : 'light';
	apply();
	notify();
	if (typeof window !== 'undefined') {
		try {
			localStorage.setItem(THEME_STORAGE_KEY, current);
		} catch (e) {
			console.warn('Failed to save theme:', e);
		}
	}
}
