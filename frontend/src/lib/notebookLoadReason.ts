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

import { formatIdleTimeout } from '$lib/notebookIdleTimeout';

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
	// The worker reclaims RAM from kernels no browser has touched for the
	// notebook's idle timeout; opening the notebook loads it again. The label
	// below is the fallback for a payload that does not carry the duration —
	// callers that have it pass `idleTimeoutSeconds` and get the real one.
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

export interface LoadReasonOptions {
	/**
	 * The notebook's *effective* idle timeout in seconds, as resolved by the
	 * control plane. Names the real duration in the eviction label, so a
	 * notebook set to four hours does not claim it was evicted after fifteen
	 * minutes. Omit it when the duration is not known.
	 */
	idleTimeoutSeconds?: number | null;
}

/**
 * The eviction label, which is the one code whose text depends on a setting.
 *
 * Three cases rather than two, because "the caller did not say" and "the
 * caller said this notebook is never evicted" are different states. An absent
 * option keeps the historical wording (the timeout was a single server-wide
 * 15 min, and every payload that omits the field comes from a control plane
 * where it still is). A non-positive or unusable one means eviction is off
 * now, so the code on the row is from an earlier setting and no duration can
 * be named honestly.
 */
function idleEvictionLabel(fallback: string, seconds: number | null | undefined): string {
	if (seconds === undefined) return fallback;
	if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
		return `evicted after ${formatIdleTimeout(seconds)} of inactivity (frees worker RAM)`;
	}
	return 'evicted after a period of inactivity (frees worker RAM)';
}

/**
 * Translate a notebook row's `load_state` + `load_error` into something a
 * panel can show, or `null` when there is nothing to explain.
 */
export function describeLoadError(
	loadState: string,
	loadError: string | null | undefined,
	opts?: LoadReasonOptions,
): LoadReason | null {
	const code = loadError?.trim();
	if (!code) return null;
	// The control plane clears the column on a successful load, so a code on a
	// loaded row is stale; do not resurrect it.
	if (loadState === 'loaded') return null;

	const known = KNOWN_CODES[code];
	const label =
		known && code === 'idle_eviction'
			? idleEvictionLabel(known.label, opts?.idleTimeoutSeconds)
			: (known?.label ?? code);
	if (loadState === 'error' || !known || known.tone === 'failure') {
		return { heading: 'Error', label, tone: 'failure', code };
	}
	return { heading: 'Reason', label, tone: 'expected', code };
}
