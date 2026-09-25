/**
 * What a worker delete does to notebooks, in words.
 *
 * Deleting a worker deletes its nets and secrets, but its notebooks stay:
 * they hold no state of their own and re-assigning one is cheap. They are
 * left unassigned with the reason `worker_deleted`, and the user is told how
 * many before (counted from the notebooks the page lists) and after (the
 * server's own count).
 */

/** How many of `notebooks` are assigned to `workerId`. */
export function notebooksOnWorker(
	notebooks: ReadonlyArray<{ worker_id: string | null }>,
	workerId: string,
): number {
	return notebooks.filter((n) => n.worker_id === workerId).length;
}

function notebooks(count: number): string {
	return `${count} notebook${count === 1 ? '' : 's'}`;
}

/** The warning beside the delete countdown. */
export function workerDeleteWarning(count: number): string {
	if (count <= 0) return 'No notebooks will be left unassigned.';
	return `${notebooks(count)} will be left unassigned.`;
}

/** The message after the delete, repeating the server's count. */
export function workerDeletedMessage(workerName: string, count: number): string {
	if (count <= 0) return `Deleted ${workerName}. No notebooks were left unassigned.`;
	return (
		`Deleted ${workerName}. ${notebooks(count)} left unassigned: ` +
		'assign or delete them on the Notebooks page.'
	);
}
