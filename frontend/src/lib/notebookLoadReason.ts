/**
 * What a notebook row's `load_error` column means, for display.
 *
 * The control plane keeps one column for "why did `load_state` change", so the
 * worker's idle eviction, a crashed kernel, a worker teardown and a genuine
 * failure all land in `load_error`. The notebook page translated the codes it
 * knew; the wiring panel printed every one of them in red under an "Error"
 * heading, so a notebook that had merely sat unopened for fifteen minutes
 * looked broken. Both now read this table.
 *
 * The codes are stamped server-side (worker `_notify_control_plane_unloaded`,
 * control-plane `mark_worker_notebooks_unloaded`) and are the source of truth.
 * An unknown code is shown as-is in the failure tone: a reason this build has
 * not heard of is not one it can vouch for.
 */

export type LoadReasonTone = 'expected' | 'failure';

export interface LoadReason {
	/** Row heading: "Reason" for an explained, expected unload; "Error" otherwise. */
	heading: 'Reason' | 'Error';
	/** Human-readable text, or the raw code when it is not a known one. */
	label: string;
	tone: LoadReasonTone;
	/** The code exactly as stored, for tooltips and `<code>` elements. */
	code: string;
}

const KNOWN_CODES: Record<string, { label: string; tone: LoadReasonTone }> = {
	// The worker reclaims RAM from kernels no browser has touched for
	// NOTEBOOK_IDLE_TIMEOUT_S; opening the notebook loads it again.
	idle_eviction: {
		label: 'evicted after 15 min of inactivity (frees worker RAM)',
		tone: 'expected',
	},
	// User actions on the Workers page; the subprocess died with the machine.
	worker_stopped: { label: 'worker was stopped', tone: 'expected' },
	worker_destroyed: { label: 'worker resource was destroyed', tone: 'expected' },
	worker_deleted: { label: 'worker was deleted', tone: 'expected' },
	worker_torn_down: { label: 'worker was torn down', tone: 'expected' },
	// The worker lost the kernel without being asked to.
	subprocess_dead: { label: 'subprocess unreachable — likely crashed', tone: 'failure' },
	subprocess_gone: {
		label: 'subprocess is gone (crash, OOM, or worker restart)',
		tone: 'failure',
	},
};

/**
 * Translate a notebook row's `load_state` + `load_error` into something a
 * panel can show, or `null` when there is nothing to explain.
 */
export function describeLoadError(
	loadState: string,
	loadError: string | null | undefined,
): LoadReason | null {
	const code = loadError?.trim();
	if (!code) return null;
	// The control plane clears the column on a successful load, so a code on a
	// loaded row is stale; do not resurrect it.
	if (loadState === 'loaded') return null;

	const known = KNOWN_CODES[code];
	if (loadState === 'error' || !known || known.tone === 'failure') {
		return { heading: 'Error', label: known?.label ?? code, tone: 'failure', code };
	}
	return { heading: 'Reason', label: known.label, tone: 'expected', code };
}
