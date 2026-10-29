/**
 * Pure helpers for the shares page: a share's state and link, the net picker
 * that keeps a world on one worker, the mint request built from the form, a
 * bundle's size as the bundles section shows it, and whether a zip is small
 * enough to upload.
 *
 * The form refuses nothing the server does not refuse. It builds the request
 * from what the owner typed and leaves every judgement of it to the server,
 * whose sentence the page shows. What it does decide is what to leave out: a
 * seat and the per-net lists belong only on a play share, an email only on a
 * named one and a bundle only on a world, and the server refuses each anywhere
 * else. The one check made before sending is a bundle zip's size, against the
 * server's own cap and with its own sentence (`bundleFileRefusal`).
 */

import type {
	Share,
	ShareAudience,
	ShareCreated,
	ShareNet,
	ShareNetRequest,
	ShareRequest,
	ShareResourceKind,
	ShareScope,
	WiringNet,
	WiringWorker,
} from '$lib/api';
import { workerLabel } from '$lib/netInstances';

export type ShareStatus = 'active' | 'expired' | 'revoked';

/** The defaults the server applies, shown in the form. */
export const DEFAULT_EXPIRES_IN_DAYS = 30;
export const DEFAULT_MAX_VIEWERS = 20;
export const DEFAULT_INPUTS_PER_MINUTE = 60;

export function shareStatus(share: Pick<Share, 'revoked_at' | 'expires_at'>, nowMs: number): ShareStatus {
	if (share.revoked_at) return 'revoked';
	return Date.parse(share.expires_at) <= nowMs ? 'expired' : 'active';
}

export function shareTokenLabel(prefix: string): string {
	return `petri_share_${prefix}…`;
}

// -- the link --

/** The public tier's base URL that links are made from, or why there is none. */
export type ShareLinkBase = { base: string; problem: null } | { base: null; problem: string };

/**
 * Judge `PUBLIC_SHARE_URL`. An unset value is the expected state until the
 * public tier exists, and a value that is not an http(s) URL (https in
 * production) cannot make a link either; both leave the page showing the bare
 * token with the reason, rather than stopping the app.
 */
export function shareLinkBase(raw: string | undefined, production: boolean): ShareLinkBase {
	const value = (raw ?? '').trim();
	if (!value) return { base: null, problem: 'PUBLIC_SHARE_URL is not set' };
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return { base: null, problem: `PUBLIC_SHARE_URL is not a URL: "${value}"` };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { base: null, problem: `PUBLIC_SHARE_URL must be an http(s) URL, not "${parsed.protocol}"` };
	}
	if (production && parsed.protocol !== 'https:') {
		return { base: null, problem: 'PUBLIC_SHARE_URL must use https:// in production' };
	}
	return { base: value.replace(/\/+$/, ''), problem: null };
}

/** The link a viewer opens: the public tier's landing page for the share. */
export function shareLink(base: string, token: string): string {
	return `${base}/s/${encodeURIComponent(token)}`;
}

// -- a share's nets --

/**
 * Why a world share cannot be served as it stands, or null. A world is
 * minted on one worker, but its nets can be reassigned, lose their worker or
 * be deleted afterwards, and the listing reads each net's worker as it is
 * now.
 */
export function worldProblem(share: Pick<Share, 'resource_kind' | 'nets'>): string | null {
	if (share.resource_kind !== 'world') return null;
	if (share.nets.length === 0) return 'Its nets have all been deleted.';
	if (share.nets.some((n) => n.worker_id === null)) {
		return 'A net of this world is on no worker now, so the world cannot be served.';
	}
	if (new Set(share.nets.map((n) => n.worker_id)).size > 1) {
		return 'Its nets are on more than one worker now, so the world cannot be served.';
	}
	return null;
}

/** What a play share may do on one net, such as "places moves, chat;
 *  controls resign", or null when it lists nothing there. */
export function describeInputs(net: Pick<ShareNet, 'play_places' | 'play_controls'>): string | null {
	const parts = [
		net.play_places.length > 0 ? `places ${net.play_places.join(', ')}` : null,
		net.play_controls.length > 0 ? `controls ${net.play_controls.join(', ')}` : null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join('; ') : null;
}

// -- the net picker --

export interface WorkerGroup {
	workerId: string | null;
	label: string;
	nets: WiringNet[];
}

/** The nets grouped by the worker each is on, workers by label and nets by
 *  instance name, with the nets on no worker last. */
export function netsByWorker(
	nets: readonly WiringNet[],
	workers: readonly Pick<WiringWorker, 'id' | 'name'>[],
): WorkerGroup[] {
	const groups = new Map<string | null, WiringNet[]>();
	for (const net of nets) {
		groups.set(net.worker_id, [...(groups.get(net.worker_id) ?? []), net]);
	}
	return [...groups.entries()]
		.map(([workerId, members]) => ({
			workerId,
			label: workerLabel(workerId, workers),
			nets: [...members].sort((a, b) => a.instance_name.localeCompare(b.instance_name)),
		}))
		.sort((a, b) => {
			if ((a.workerId === null) !== (b.workerId === null)) return a.workerId === null ? 1 : -1;
			return a.label.localeCompare(b.label);
		});
}

export const NO_WORKER_REASON = 'On no worker: assign these nets to a worker to share them.';
export const OTHER_WORKER_REASON = "On another worker than the nets picked: a world's nets are all on one worker.";

/** The workers the picked nets are on. */
export function pickedWorkers(
	picked: readonly string[],
	nets: readonly Pick<WiringNet, 'id' | 'worker_id'>[],
): Set<string | null> {
	return new Set(
		picked.flatMap((id) => {
			const net = nets.find((n) => n.id === id);
			return net ? [net.worker_id] : [];
		}),
	);
}

/** Why a net on this worker cannot join the picked nets, or null when it can.
 *  The server refuses both: a net on no worker, and nets on two workers. */
export function pickRefusal(workerId: string | null, picked: ReadonlySet<string | null>): string | null {
	if (workerId === null) return NO_WORKER_REASON;
	if (picked.size > 0 && !picked.has(workerId)) return OTHER_WORKER_REASON;
	return null;
}

/** The picked net ids with one net added or taken away, in picking order. */
export function togglePicked(picked: readonly string[], netId: string, on: boolean): string[] {
	const without = picked.filter((id) => id !== netId);
	return on ? [...without, netId] : without;
}

// -- the form --

export interface ShareForm {
	label: string;
	resourceKind: ShareResourceKind;
	/** The picked nets of a world, in picking order. */
	netIds: string[];
	/** Comma-separated place and control names per net id, for a play share. */
	playPlaces: Record<string, string>;
	playControls: Record<string, string>;
	notebookId: string | null;
	scope: ShareScope;
	seat: string;
	audience: ShareAudience;
	memberEmail: string;
	/** Null when the field is empty: the server's default applies. */
	expiresInDays: number | null;
	publishPayloads: boolean;
	maxViewers: number | null;
	inputsPerMinute: number | null;
	/** The bundle a world serves, or null for none. */
	bundleId: string | null;
}

export function emptyShareForm(): ShareForm {
	return {
		label: '',
		resourceKind: 'world',
		netIds: [],
		playPlaces: {},
		playControls: {},
		notebookId: null,
		scope: 'read',
		seat: '',
		audience: 'link',
		memberEmail: '',
		expiresInDays: DEFAULT_EXPIRES_IN_DAYS,
		publishPayloads: false,
		maxViewers: DEFAULT_MAX_VIEWERS,
		inputsPerMinute: DEFAULT_INPUTS_PER_MINUTE,
		bundleId: null,
	};
}

/** A comma-separated list of names, each trimmed, the empty ones dropped. */
export function parseNames(text: string | undefined): string[] {
	return (text ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

type NumberField = 'expires_in_days' | 'max_viewers' | 'inputs_per_minute';

/** An empty number field is left out of the request, so the server's default applies. */
function optionalNumber(field: NumberField, value: number | null): Partial<Pick<ShareRequest, NumberField>> {
	return value === null || value === undefined ? {} : { [field]: value };
}

/** The mint request for the form as it stands. */
export function shareRequest(form: ShareForm): ShareRequest {
	const play = form.scope === 'play';
	const resource: Partial<ShareRequest> =
		form.resourceKind === 'world'
			? {
					nets: form.netIds.map(
						(id): ShareNetRequest =>
							play
								? {
										net_id: id,
										play_places: parseNames(form.playPlaces[id]),
										play_controls: parseNames(form.playControls[id]),
									}
								: { net_id: id },
					),
					...(form.bundleId ? { bundle_id: form.bundleId } : {}),
				}
			: { notebook_id: form.notebookId };
	return {
		label: form.label,
		resource_kind: form.resourceKind,
		...resource,
		scope: form.scope,
		...(play ? { seat: form.seat } : {}),
		audience: form.audience,
		...(form.audience === 'named' ? { member_email: form.memberEmail } : {}),
		...optionalNumber('expires_in_days', form.expiresInDays),
		publish_payloads: form.publishPayloads,
		...optionalNumber('max_viewers', form.maxViewers),
		...optionalNumber('inputs_per_minute', form.inputsPerMinute),
	};
}

/** The listed share for a mint answer, without the secret it carried. */
export function withoutToken(created: ShareCreated): Share {
	const { token: _token, ...share } = created;
	return share;
}

// -- bundles --

const BYTES_PER_MB = 1_000_000;
const BYTES_PER_MIB = 1024 * 1024;

/** The largest zip the server reads, `MAX_UPLOAD_BYTES` in its `bundles/rules.py`. */
export const MAX_BUNDLE_ZIP_BYTES = 64 * BYTES_PER_MIB;

/** The server's 413 sentence for a larger zip. */
export const BUNDLE_TOO_LARGE = `A bundle's zip is at most ${MAX_BUNDLE_ZIP_BYTES / BYTES_PER_MIB} MiB.`;

/**
 * Why a zip of this many bytes cannot be uploaded, or null when it can be
 * sent. The server refuses a larger zip with 413, but it can answer before
 * the browser has sent the whole body, and a browser may then report the
 * upload as a failed fetch instead of the answer, so the page refuses it
 * first, in the server's words, without a request.
 */
export function bundleFileRefusal(sizeBytes: number): string | null {
	return sizeBytes > MAX_BUNDLE_ZIP_BYTES ? BUNDLE_TOO_LARGE : null;
}

/** A size in megabytes (millions of bytes) to one decimal, such as "12.3 MB".
 *  A bundle too small to show at that precision is "under 0.1 MB" rather
 *  than reading as empty. */
export function formatBundleSize(bytes: number): string {
	const mb = bytes / BYTES_PER_MB;
	if (bytes > 0 && mb < 0.05) return 'under 0.1 MB';
	return `${mb.toFixed(1)} MB`;
}
