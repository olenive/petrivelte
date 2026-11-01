/**
 * Pure helpers for the Sharing page: a share's state, its link or public
 * address, the owner's public handles (which one the form offers first, the
 * count against the limit, whether one is in use, what releasing one risks),
 * the net picker that keeps a world on one worker, the slug a public share's
 * label suggests, the warning that publishing payloads shows token values to
 * whoever can reach the share, the mint request built from the form, a
 * bundle's size as the bundles section shows it, and whether a zip is small
 * enough to upload.
 *
 * The form refuses nothing the server does not refuse. It builds the request
 * from what the owner typed and leaves every judgement of it to the server,
 * whose sentence the page shows. What it does decide is what to leave out: a
 * seat and the per-net lists belong only on a play share, an email only on a
 * named one, a handle and a slug only on a public one and a bundle only on a
 * world, and the server refuses each anywhere else. Choosing the public audience also
 * sets the scope to read, since a public share is read only. The one check
 * made before sending is a bundle zip's size, against the server's own cap
 * and with its own sentence (`bundleFileRefusal`).
 */

import type {
	PublicHandle,
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

/** The defaults the server applies, shown in the form. A public share lasts
 *  a year by default, since its address is meant to last. */
export const DEFAULT_EXPIRES_IN_DAYS = 30;
export const DEFAULT_PUBLIC_EXPIRES_IN_DAYS = 365;
export const DEFAULT_MAX_VIEWERS = 20;
export const DEFAULT_INPUTS_PER_MINUTE = 60;

/** The days the server gives a share of this audience when the mint leaves
 *  `expires_in_days` out. */
export function defaultExpiresInDays(audience: ShareAudience): number {
	return audience === 'public' ? DEFAULT_PUBLIC_EXPIRES_IN_DAYS : DEFAULT_EXPIRES_IN_DAYS;
}

export function shareStatus(share: Pick<Share, 'revoked_at' | 'expires_at'>, nowMs: number): ShareStatus {
	if (share.revoked_at) return 'revoked';
	return Date.parse(share.expires_at) <= nowMs ? 'expired' : 'active';
}

export function shareTokenLabel(prefix: string): string {
	return `petri_share_${prefix}…`;
}

/** Whether the list offers Revoke: on an active share, and on an expired
 *  public share too, which holds its address until it is revoked, so that
 *  revoking it is how the address is freed for a new share. */
export function canRevoke(share: Pick<Share, 'audience'>, status: ShareStatus): boolean {
	return status === 'active' || (status === 'expired' && share.audience === 'public');
}

/** The question Revoke asks first. */
export function revokePrompt(share: Pick<Share, 'audience'>, status: ShareStatus): string {
	if (share.audience !== 'public') {
		return 'Revoke it? Anyone holding its link loses access, and it cannot be restored.';
	}
	return status === 'active'
		? 'Revoke it? Its address stops answering, and it cannot be restored; a new share can then take the address.'
		: 'Revoke it? That frees its address for a new share, and it cannot be restored.';
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

/** A public share's address: the public tier's base followed by the share's
 *  `public_path`, which the server gives as `/p/<handle>/<slug>`. */
export function publicLink(base: string, publicPath: string): string {
	return `${base}${publicPath}`;
}

/** A public share's address as the page shows it: the full address, or the
 *  path alone when the public tier's address is not configured. */
export function publicAddress(base: string | null, publicPath: string): string {
	return base === null ? publicPath : publicLink(base, publicPath);
}

/**
 * What the created panel shows and copies. A public share shows its address
 * and never its token: the address is how it is reached, and is not a
 * secret. Any other share shows its link, which holds the token. Without a
 * configured public tier, the path or the bare token stands alone and the
 * panel says why.
 */
export function createdShareText(
	created: Pick<ShareCreated, 'token' | 'public_path'>,
	base: string | null,
): string {
	if (created.public_path !== null) return publicAddress(base, created.public_path);
	return base === null ? created.token : shareLink(base, created.token);
}

// -- a public share's address --

/** The longest slug the server takes. */
export const MAX_SLUG_LENGTH = 60;

function trimHyphens(text: string): string {
	return text.replace(/^-+|-+$/g, '');
}

/**
 * The slug a label suggests: lowercased, every run of characters other than
 * a to z and 0 to 9 one hyphen, hyphens trimmed from both ends, cut to 60
 * characters and trimmed again, since the cut can end on a hyphen. A label
 * with no letter or digit suggests an empty slug, which the server refuses
 * in its own words.
 */
export function slugFromLabel(label: string): string {
	const hyphenated = trimHyphens(label.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
	return trimHyphens(hyphenated.slice(0, MAX_SLUG_LENGTH));
}

/** The path a public share would be at, for the form's preview; the handle
 *  reads `<your handle>` until one is reserved and chosen. */
export function previewPublicPath(handle: string | null, slug: string): string {
	return `/p/${handle ?? '<your handle>'}/${slug}`;
}

// -- public handles --

/**
 * The handle the form offers first: the one a public share was last minted
 * under, by `last_used_at`, else the first of the list, which the server
 * gives oldest first; null when the owner holds none. The instants are
 * compared, never their text, and a tie goes to the older handle.
 */
export function defaultHandle(handles: readonly Pick<PublicHandle, 'handle' | 'last_used_at'>[]): string | null {
	const used = handles
		.map((h) => ({ handle: h.handle, at: h.last_used_at === null ? NaN : Date.parse(h.last_used_at) }))
		.filter((h) => !Number.isNaN(h.at));
	if (used.length === 0) return handles[0]?.handle ?? null;
	return used.reduce((latest, h) => (h.at > latest.at ? h : latest)).handle;
}

/** The form's handle against the owner's handles as they are now: the one
 *  chosen while the owner still holds it, else the default. */
export function keepHandle(
	chosen: string | null,
	handles: readonly Pick<PublicHandle, 'handle' | 'last_used_at'>[],
): string | null {
	return chosen !== null && handles.some((h) => h.handle === chosen) ? chosen : defaultHandle(handles);
}

/** A count with its noun, plural unless the count is one. */
function counted(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The box's count against the account's limit, such as "2 of 3 handles reserved". */
export function handlesReservedText(count: number, limit: number): string {
	return `${count} of ${counted(limit, 'handle')} reserved`;
}

/** Whether the account may reserve another handle. */
export function hasRoomForHandle(count: number, limit: number): boolean {
	return count < limit;
}

/** Whether a handle is in use: an unrevoked public share is minted under it,
 *  expired or not. Renaming one in use would move every live address under
 *  it, and releasing it would let another account publish at them, so the
 *  server refuses both. */
export function handleInUse(handle: Pick<PublicHandle, 'live_shares'>): boolean {
	return handle.live_shares > 0;
}

/** A handle's live shares as its row counts them. */
export function describeLiveShares(handle: Pick<PublicHandle, 'live_shares'>): string {
	return handle.live_shares === 0 ? 'no live shares' : counted(handle.live_shares, 'live share');
}

/** What a handle in use shows in place of Rename and Release. */
export function handleInUseNote(handle: Pick<PublicHandle, 'live_shares'>): string {
	return `revoke its ${counted(handle.live_shares, 'public share')} first`;
}

/** The question Release asks first. A released handle is free for anyone,
 *  and a new holder could publish at the addresses this owner used under it. */
export function releaseWarning(handle: string): string {
	return (
		`Release ${handle}? It will no longer be reserved for you: anyone may take it, ` +
		'and a new holder could publish at addresses you once used.'
	);
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
	/** The handle a public share is minted under, one of the owner's; null
	 *  while none is chosen. The page keeps it with `keepHandle`. */
	handle: string | null;
	/** A public share's slug as the owner typed it; read through `formSlug`. */
	slug: string;
	/** Whether the owner has edited the slug. Until then it follows the label. */
	slugEdited: boolean;
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
		handle: null,
		slug: '',
		slugEdited: false,
		expiresInDays: DEFAULT_EXPIRES_IN_DAYS,
		publishPayloads: false,
		maxViewers: DEFAULT_MAX_VIEWERS,
		inputsPerMinute: DEFAULT_INPUTS_PER_MINUTE,
		bundleId: null,
	};
}

/** The slug the form holds: the label's suggestion until the owner edits the
 *  slug, and what the owner typed from then on. */
export function formSlug(form: Pick<ShareForm, 'label' | 'slug' | 'slugEdited'>): string {
	return form.slugEdited ? form.slug : slugFromLabel(form.label);
}

/**
 * The form with another audience chosen. A public share is read only, so
 * choosing public sets the scope to read. An expiry still at the old
 * audience's default moves to the new one's, so a public share left alone
 * lasts the year the server would give it; a number the owner typed stays,
 * and so does an emptied field, which the server fills with its own default.
 */
export function withAudience(form: ShareForm, audience: ShareAudience): ShareForm {
	const expiresInDays =
		form.expiresInDays === defaultExpiresInDays(form.audience) ? defaultExpiresInDays(audience) : form.expiresInDays;
	return { ...form, audience, expiresInDays, scope: audience === 'public' ? 'read' : form.scope };
}

/**
 * What the form says under "Publish payloads" while it is ticked, or null.
 * Published payloads show every token's value to whoever can open the share,
 * so a public share shows them to anyone at its address and a link share to
 * anyone the link reaches. A named share says nothing more: the owner chooses
 * its one viewer, and the checkbox's help text already says what publishing
 * shows.
 */
export function payloadWarning(form: Pick<ShareForm, 'audience' | 'publishPayloads'>): string | null {
	if (!form.publishPayloads) return null;
	if (form.audience === 'public') return 'Token values will be visible to anyone, at a public address.';
	if (form.audience === 'link') return 'Token values will be visible to anyone who has the link.';
	return null;
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
		...(form.audience === 'public' ? { handle: form.handle, slug: formSlug(form) } : {}),
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
