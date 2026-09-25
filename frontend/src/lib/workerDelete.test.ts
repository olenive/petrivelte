import { describe, expect, it } from 'vitest';

import { notebooksOnWorker, workerDeleteWarning, workerDeletedMessage } from './workerDelete';

describe('notebooksOnWorker', () => {
	it('counts only the notebooks assigned to that worker', () => {
		const notebooks = [
			{ worker_id: 'w-1' },
			{ worker_id: 'w-2' },
			{ worker_id: 'w-1' },
			{ worker_id: null },
		];
		expect(notebooksOnWorker(notebooks, 'w-1')).toBe(2);
		expect(notebooksOnWorker(notebooks, 'w-3')).toBe(0);
	});
});

describe('worker delete dialog text', () => {
	it('says how many notebooks will be left unassigned', () => {
		expect(workerDeleteWarning(3)).toBe('3 notebooks will be left unassigned.');
		expect(workerDeleteWarning(1)).toBe('1 notebook will be left unassigned.');
		expect(workerDeleteWarning(0)).toBe('No notebooks will be left unassigned.');
	});

	it('repeats the server count after the delete and says where to go', () => {
		expect(workerDeletedMessage('tailarm', 2)).toBe(
			'Deleted tailarm. 2 notebooks left unassigned: assign or delete them on the Notebooks page.',
		);
		expect(workerDeletedMessage('tailarm', 0)).toBe(
			'Deleted tailarm. No notebooks were left unassigned.',
		);
	});
});
