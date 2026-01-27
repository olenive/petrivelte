import { writable } from 'svelte/store';

export const selectedTokenId = writable<string | null>(null);
