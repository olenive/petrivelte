/**
 * Plain-English labels for the anomaly tags the control plane puts on a net.
 *
 * An anomaly is a contradiction between what the net wants and what is true,
 * such as a net that wants to run with no worker to run on. The server owns
 * the set; a tag this build does not know is shown as the tag itself so a
 * newer server is never silenced.
 */

const ANOMALY_LABELS: Record<string, string> = {
	wants_running_without_worker: 'wants running, no worker',
	wants_running_but_unloaded: 'wants running, not loaded',
	wants_running_but_load_failed: 'wants running, load failed',
	duplicate_definition_on_deployment: 'another instance of this definition on the same deployment',
};

export function anomalyLabel(tag: string): string {
	return ANOMALY_LABELS[tag] ?? tag;
}

/** The labels for a net's anomalies, in the order the server sent them. */
export function anomalyLabels(net: { anomalies?: string[] | null }): string[] {
	return (net.anomalies ?? []).map(anomalyLabel);
}

/** A short suffix for a net's entry in a plain-text list such as a select
 *  option, where a coloured badge cannot be drawn; empty when all is well. */
export function anomalySuffix(net: { anomalies?: string[] | null }): string {
	const labels = anomalyLabels(net);
	return labels.length === 0 ? '' : ` · ${labels.join('; ')}`;
}
