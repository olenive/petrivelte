import type { NotebookViewerThresholds } from './notebookThresholds';

/**
 * Thresholds for tests, at the values the control plane serves today.
 * Tests pass them explicitly, so a test that depends on one value names it.
 */
export function testThresholds(
	over: Partial<NotebookViewerThresholds> = {},
): NotebookViewerThresholds {
	return {
		stale_intervals: 3,
		silent_intervals: 6,
		default_reconcile_interval_s: 5,
		ws_open_deadline_s: 45,
		frame_stall_s: 30,
		bridge_start_deadline_s: 30,
		remount_budget: 3,
		remount_window_s: 900,
		remount_backoff_s: [5, 20],
		sync_poll_s: 5,
		...over,
	};
}
