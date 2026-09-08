/**
 * The per-notebook idle timeout, as data.
 *
 * The worker frees a notebook's kernel after a stretch with no proxied browser
 * request, to reclaim ~190MB of RAM. That stretch used to be one number for
 * every notebook on every worker (`NOTEBOOK_IDLE_TIMEOUT_S`, 15 min); a
 * dashboard someone glances at hourly wants hours, a scratch notebook wants
 * minutes. The setting now rides on the notebook row, and the control plane —
 * not the browser — resolves it: every notebook payload carries both
 * `idle_timeout_seconds` (the setting, `null` for "use the worker default")
 * and `effective_idle_timeout_seconds` (what the worker will actually apply).
 *
 * So this module never learns what the default *is*. It is handed the
 * effective value and formats it, which is why the "Default (15 min)" option
 * label changes on its own the day the env var does.
 *
 * Pure and fetch-free, like `notebookLoadReason.ts`: the interesting part is a
 * table of labels, and a table is worth asserting without a browser.
 */

/**
 * The durations offered in the picker, in seconds, ascending.
 *
 * Deliberately coarse. The interesting choice is an order of magnitude —
 * minutes, hours, a day — and a picker with eleven entries makes that choice
 * harder, not easier. Anything else is still reachable through the API, and
 * `idleTimeoutOptions` keeps such a value visible as a `custom (…)` entry
 * rather than silently snapping it to a neighbour.
 */
export const IDLE_TIMEOUT_PRESETS: readonly number[] = [1800, 3600, 14400, 43200, 86400];

/** The `<select>` value standing for the `null` setting: use the worker default. */
export const IDLE_TIMEOUT_DEFAULT_VALUE = 'default';

/** The `<select>` value standing for the `0` setting: never evict. */
export const IDLE_TIMEOUT_NEVER_VALUE = '0';

/**
 * A duration in words: `15 min`, `4 h`, `90 s`, and `never` for the zero the
 * server reads as "do not evict this one".
 *
 * Whole hours and whole minutes are preferred over the arithmetically shorter
 * unit because that is how the value was chosen; a stored 5400 reads as
 * `90 min` rather than `1.5 h` for the same reason.
 */
export function formatIdleTimeout(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return 'never';
	const n = Math.round(seconds);
	if (n % 3600 === 0) return `${n / 3600} h`;
	if (n % 60 === 0) return `${n / 60} min`;
	return `${n} s`;
}

export interface IdleTimeoutOption {
	/** The `<option value>`; `'default'` for the null setting, else the seconds. */
	value: string;
	label: string;
	/** What to PATCH when this entry is chosen: `null` resets to the default. */
	seconds: number | null;
	/** True for the entry matching the notebook's stored setting. */
	selected: boolean;
}

/** The `<select>`'s current value for a stored setting. */
export function idleTimeoutValue(setting: number | null | undefined): string {
	return setting === null || setting === undefined ? IDLE_TIMEOUT_DEFAULT_VALUE : String(setting);
}

/**
 * The inverse: what to send for a chosen `<option value>`.
 *
 * Anything unrecognised resolves to `null` — the default — because the only
 * values this can see are the ones `idleTimeoutOptions` produced, and falling
 * back to the server's own default is the harmless reading of a value this
 * build cannot explain.
 */
export function parseIdleTimeoutValue(value: string): number | null {
	if (value === IDLE_TIMEOUT_DEFAULT_VALUE) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * The picker's entries for one notebook.
 *
 * `never` sits last because it is the largest duration, not because it is the
 * odd one out, and a stored value that is not a preset is spliced into the
 * ascending run at its own position: a `custom (90 s)` entry between the
 * default and `30 min` says more about what the notebook is set to than the
 * same entry parked at the bottom of the list.
 *
 * `effectiveDefault` is the control plane's resolution, so the default entry
 * names a real duration. A payload from a control plane that predates the
 * field leaves it undefined, and the entry then reads plain `Default` — no
 * duration is better than a stale one invented here.
 */
export function idleTimeoutOptions(
	setting: number | null | undefined,
	effectiveDefault: number | null | undefined,
): IdleTimeoutOption[] {
	const current = setting ?? null;
	const isCustom =
		current !== null && current > 0 && !IDLE_TIMEOUT_PRESETS.includes(current);
	const durations = isCustom ? [...IDLE_TIMEOUT_PRESETS, current] : [...IDLE_TIMEOUT_PRESETS];
	durations.sort((a, b) => a - b);

	const defaultLabel =
		effectiveDefault === null ||
		effectiveDefault === undefined ||
		!Number.isFinite(effectiveDefault)
			? 'Default'
			: `Default (${formatIdleTimeout(effectiveDefault)})`;

	return [
		{
			value: IDLE_TIMEOUT_DEFAULT_VALUE,
			label: defaultLabel,
			seconds: null,
			selected: current === null,
		},
		...durations.map((s) => ({
			value: String(s),
			label: isCustom && s === current ? `custom (${formatIdleTimeout(s)})` : formatIdleTimeout(s),
			seconds: s,
			selected: s === current,
		})),
		{
			value: IDLE_TIMEOUT_NEVER_VALUE,
			label: 'Never',
			seconds: 0,
			selected: current === 0,
		},
	];
}
