import { describe, expect, it } from 'vitest';
import type { PublicHandle, Share, ShareCreated, ShareNet, WiringNet } from './api';
import {
	BUNDLE_TOO_LARGE,
	DEFAULT_EXPIRES_IN_DAYS,
	DEFAULT_INPUTS_PER_MINUTE,
	DEFAULT_MAX_VIEWERS,
	DEFAULT_PUBLIC_EXPIRES_IN_DAYS,
	MAX_BUNDLE_ZIP_BYTES,
	MAX_SLUG_LENGTH,
	NO_WORKER_REASON,
	OTHER_WORKER_REASON,
	bundleFileRefusal,
	canRevoke,
	createdShareText,
	defaultExpiresInDays,
	defaultHandle,
	describeInputs,
	describeLiveShares,
	emptyShareForm,
	formSlug,
	formatBundleSize,
	handleInUse,
	handleInUseNote,
	handlesReservedText,
	hasRoomForHandle,
	keepHandle,
	netsByWorker,
	parseNames,
	payloadWarning,
	pickRefusal,
	pickedWorkers,
	previewPublicPath,
	publicAddress,
	publicLink,
	releaseWarning,
	revokePrompt,
	shareLink,
	shareLinkBase,
	shareRequest,
	shareStatus,
	shareTokenLabel,
	slugFromLabel,
	togglePicked,
	withAudience,
	withoutToken,
	worldProblem,
	type ShareForm,
} from './shares';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const W1 = 'worker-1-0000';
const W2 = 'worker-2-0000';

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function shareNet(net_id: string, worker_id: string | null): ShareNet {
	return { net_id, definition_name: 'def', instance_name: net_id, worker_id, play_places: [], play_controls: [] };
}

function share(overrides: Partial<Share> = {}): Share {
	return {
		id: 's1',
		label: 'demo',
		resource_kind: 'world',
		notebook_id: null,
		notebook_name: null,
		scope: 'read',
		audience: 'link',
		member_email: null,
		seat: null,
		handle: null,
		slug: null,
		public_path: null,
		prefix: 'abcdefgh',
		publish_payloads: false,
		max_viewers: 20,
		inputs_per_minute: 60,
		created_at: iso(NOW - DAY),
		expires_at: iso(NOW + 29 * DAY),
		revoked_at: null,
		last_used_at: null,
		bundle_id: null,
		bundle_label: null,
		nets: [shareNet('net-a', W1)],
		...overrides,
	};
}

function net(id: string, worker_id: string | null, instance_name = id): WiringNet {
	return {
		id,
		definition_name: 'def',
		instance_name,
		worker_id,
		deployment_id: null,
		load_state: 'loaded',
		load_error: null,
	};
}

function form(overrides: Partial<ShareForm> = {}): ShareForm {
	return { ...emptyShareForm(), label: 'demo', netIds: ['net-a'], ...overrides };
}

describe('shareStatus', () => {
	it('is active before its expiry', () => {
		expect(shareStatus(share(), NOW)).toBe('active');
		expect(shareStatus(share({ expires_at: iso(NOW + 1) }), NOW)).toBe('active');
	});

	it('is expired at the expiry instant and after', () => {
		expect(shareStatus(share({ expires_at: iso(NOW) }), NOW)).toBe('expired');
		expect(shareStatus(share({ expires_at: iso(NOW - DAY) }), NOW)).toBe('expired');
	});

	it('is revoked whatever the expiry says', () => {
		expect(shareStatus(share({ revoked_at: iso(NOW - DAY) }), NOW)).toBe('revoked');
		expect(shareStatus(share({ revoked_at: iso(NOW - DAY), expires_at: iso(NOW - DAY) }), NOW)).toBe('revoked');
	});

	it('compares instants, whatever offset the server wrote', () => {
		expect(shareStatus(share({ expires_at: '2026-10-29T13:00:00+02:00' }), NOW)).toBe('expired');
		expect(shareStatus(share({ expires_at: '2026-10-29T11:30:00-01:00' }), NOW)).toBe('active');
	});
});

describe('shareTokenLabel', () => {
	it('shows the fixed prefix, the stored prefix and an ellipsis', () => {
		expect(shareTokenLabel('abcdefgh')).toBe('petri_share_abcdefgh…');
	});
});

describe('canRevoke', () => {
	it('is offered on an active share of every audience', () => {
		expect(canRevoke({ audience: 'link' }, 'active')).toBe(true);
		expect(canRevoke({ audience: 'named' }, 'active')).toBe(true);
		expect(canRevoke({ audience: 'public' }, 'active')).toBe(true);
	});

	it('is offered on an expired public share, which holds its address until revoked', () => {
		expect(canRevoke({ audience: 'public' }, 'expired')).toBe(true);
		expect(canRevoke({ audience: 'link' }, 'expired')).toBe(false);
		expect(canRevoke({ audience: 'named' }, 'expired')).toBe(false);
	});

	it('is never offered on a revoked share', () => {
		expect(canRevoke({ audience: 'public' }, 'revoked')).toBe(false);
		expect(canRevoke({ audience: 'link' }, 'revoked')).toBe(false);
	});
});

describe('revokePrompt', () => {
	it('warns that a link stops working', () => {
		expect(revokePrompt({ audience: 'link' }, 'active')).toBe(
			'Revoke it? Anyone holding its link loses access, and it cannot be restored.',
		);
		expect(revokePrompt({ audience: 'named' }, 'active')).toContain('Anyone holding its link loses access');
	});

	it('says a public share\'s address stops answering and can be taken again', () => {
		expect(revokePrompt({ audience: 'public' }, 'active')).toBe(
			'Revoke it? Its address stops answering, and it cannot be restored; a new share can then take the address.',
		);
	});

	it('says revoking an expired public share frees its address', () => {
		expect(revokePrompt({ audience: 'public' }, 'expired')).toBe(
			'Revoke it? That frees its address for a new share, and it cannot be restored.',
		);
	});
});

describe('shareLinkBase', () => {
	it('is the trimmed URL without a trailing slash', () => {
		expect(shareLinkBase(' https://petrify-public.fly.dev/ ', true)).toEqual({
			base: 'https://petrify-public.fly.dev',
			problem: null,
		});
	});

	it('takes plain http outside production', () => {
		expect(shareLinkBase('http://localhost:8100', false).base).toBe('http://localhost:8100');
	});

	it('says the value is not set when it is empty or missing', () => {
		expect(shareLinkBase('', true)).toEqual({ base: null, problem: 'PUBLIC_SHARE_URL is not set' });
		expect(shareLinkBase('   ', false).problem).toBe('PUBLIC_SHARE_URL is not set');
		expect(shareLinkBase(undefined, false).problem).toBe('PUBLIC_SHARE_URL is not set');
	});

	it('names a value that cannot make a link', () => {
		expect(shareLinkBase('petrify-public', false).problem).toBe('PUBLIC_SHARE_URL is not a URL: "petrify-public"');
		expect(shareLinkBase('ftp://files.example', false).problem).toBe(
			'PUBLIC_SHARE_URL must be an http(s) URL, not "ftp:"',
		);
		expect(shareLinkBase('http://petrify-public.fly.dev', true).problem).toBe(
			'PUBLIC_SHARE_URL must use https:// in production',
		);
	});
});

describe('shareLink', () => {
	it('is the base, /s/ and the token', () => {
		expect(shareLink('https://petrify-public.fly.dev', 'petri_share_Ab-9_x')).toBe(
			'https://petrify-public.fly.dev/s/petri_share_Ab-9_x',
		);
	});
});

describe('publicLink', () => {
	it('is the base followed by the share\'s public path', () => {
		expect(publicLink('https://petrify-public.fly.dev', '/p/oleg/reachability')).toBe(
			'https://petrify-public.fly.dev/p/oleg/reachability',
		);
	});
});

describe('publicAddress', () => {
	it('is the full address when the public tier\'s address is configured', () => {
		expect(publicAddress('https://share.test', '/p/oleg/boards')).toBe('https://share.test/p/oleg/boards');
	});

	it('is the path alone when it is not', () => {
		expect(publicAddress(null, '/p/oleg/boards')).toBe('/p/oleg/boards');
	});
});

describe('createdShareText', () => {
	const TOKEN = 'petri_share_Ab-9_x';

	it('is a link share\'s link, which holds its token', () => {
		expect(createdShareText({ token: TOKEN, public_path: null }, 'https://share.test')).toBe(
			'https://share.test/s/petri_share_Ab-9_x',
		);
	});

	it('is a public share\'s address and never its token', () => {
		const text = createdShareText({ token: TOKEN, public_path: '/p/oleg/boards' }, 'https://share.test');
		expect(text).toBe('https://share.test/p/oleg/boards');
		expect(text).not.toContain(TOKEN);
	});

	it('falls back to the bare token, or the bare path, without a public tier address', () => {
		expect(createdShareText({ token: TOKEN, public_path: null }, null)).toBe(TOKEN);
		expect(createdShareText({ token: TOKEN, public_path: '/p/oleg/boards' }, null)).toBe('/p/oleg/boards');
	});
});

describe('slugFromLabel', () => {
	it('lowercases and turns each run of other characters into one hyphen', () => {
		expect(slugFromLabel('Reachability boards')).toBe('reachability-boards');
		expect(slugFromLabel('nb  reachability -- v2!')).toBe('nb-reachability-v2');
		expect(slugFromLabel('Traffic_Light.2026')).toBe('traffic-light-2026');
	});

	it('trims hyphens from both ends', () => {
		expect(slugFromLabel('  (draft) status board  ')).toBe('draft-status-board');
		expect(slugFromLabel('--status--')).toBe('status');
	});

	it('treats letters outside a to z as separators', () => {
		expect(slugFromLabel('Café Zürich')).toBe('caf-z-rich');
	});

	it('cuts to 60 characters and trims a hyphen the cut leaves at the end', () => {
		const long = 'a'.repeat(59) + ' board';
		expect(slugFromLabel(long)).toBe('a'.repeat(59));
		expect(slugFromLabel('b'.repeat(80))).toBe('b'.repeat(MAX_SLUG_LENGTH));
		expect(MAX_SLUG_LENGTH).toBe(60);
	});

	it('suggests nothing for a label with no letter or digit', () => {
		expect(slugFromLabel('')).toBe('');
		expect(slugFromLabel(' !? ')).toBe('');
	});
});

describe('previewPublicPath', () => {
	it('is /p/, the handle and the slug', () => {
		expect(previewPublicPath('oleg', 'boards')).toBe('/p/oleg/boards');
	});

	it('holds a place for a handle not chosen yet', () => {
		expect(previewPublicPath(null, 'boards')).toBe('/p/<your handle>/boards');
	});
});

function handle(name: string, overrides: Partial<PublicHandle> = {}): PublicHandle {
	return { handle: name, reserved_at: iso(NOW - 10 * DAY), last_used_at: null, live_shares: 0, ...overrides };
}

describe('defaultHandle', () => {
	it('is the handle a public share was last minted under', () => {
		const handles = [
			handle('oleg', { last_used_at: iso(NOW - 3 * DAY) }),
			handle('tailarm', { last_used_at: iso(NOW - DAY) }),
			handle('games'),
		];
		expect(defaultHandle(handles)).toBe('tailarm');
	});

	it('compares instants, not text, so an offset that sorts first as text can still be the latest', () => {
		// 11:00 at +02:00 is 09:00 UTC, before 10:00Z, though it sorts after it as text.
		const handles = [
			handle('oleg', { last_used_at: '2026-10-31T11:00:00+02:00' }),
			handle('tailarm', { last_used_at: '2026-10-31T10:00:00Z' }),
		];
		expect(defaultHandle(handles)).toBe('tailarm');
	});

	it('falls back to the first, the oldest, when none has been used', () => {
		expect(defaultHandle([handle('oleg'), handle('tailarm')])).toBe('oleg');
	});

	it('gives a tie to the older handle', () => {
		const at = iso(NOW - DAY);
		expect(defaultHandle([handle('oleg', { last_used_at: at }), handle('tailarm', { last_used_at: at })])).toBe('oleg');
	});

	it('is null when the owner holds none', () => {
		expect(defaultHandle([])).toBeNull();
	});
});

describe('keepHandle', () => {
	const handles = [handle('oleg'), handle('tailarm', { last_used_at: iso(NOW - DAY) })];

	it('keeps the chosen handle while the owner still holds it', () => {
		expect(keepHandle('oleg', handles)).toBe('oleg');
	});

	it('falls to the default when the chosen handle is gone, renamed or released', () => {
		expect(keepHandle('games', handles)).toBe('tailarm');
	});

	it('takes the default when none was chosen, and null when there is none', () => {
		expect(keepHandle(null, handles)).toBe('tailarm');
		expect(keepHandle(null, [])).toBeNull();
		expect(keepHandle('oleg', [])).toBeNull();
	});
});

describe('handlesReservedText', () => {
	it('counts the handles held against the limit', () => {
		expect(handlesReservedText(2, 3)).toBe('2 of 3 handles reserved');
		expect(handlesReservedText(0, 3)).toBe('0 of 3 handles reserved');
	});

	it('speaks of one handle when the limit is one', () => {
		expect(handlesReservedText(1, 1)).toBe('1 of 1 handle reserved');
	});
});

describe('hasRoomForHandle', () => {
	it('is true below the limit and false at or past it', () => {
		expect(hasRoomForHandle(2, 3)).toBe(true);
		expect(hasRoomForHandle(3, 3)).toBe(false);
		expect(hasRoomForHandle(4, 3)).toBe(false);
		expect(hasRoomForHandle(0, 0)).toBe(false);
	});
});

describe('handleInUse', () => {
	it('is in use while any unrevoked public share is minted under it', () => {
		expect(handleInUse(handle('oleg', { live_shares: 1 }))).toBe(true);
		expect(handleInUse(handle('oleg', { live_shares: 0 }))).toBe(false);
	});
});

describe('describeLiveShares', () => {
	it('counts a handle\'s live shares', () => {
		expect(describeLiveShares(handle('oleg', { live_shares: 0 }))).toBe('no live shares');
		expect(describeLiveShares(handle('oleg', { live_shares: 1 }))).toBe('1 live share');
		expect(describeLiveShares(handle('oleg', { live_shares: 2 }))).toBe('2 live shares');
	});
});

describe('handleInUseNote', () => {
	it('says how many public shares to revoke first', () => {
		expect(handleInUseNote(handle('oleg', { live_shares: 2 }))).toBe('revoke its 2 public shares first');
		expect(handleInUseNote(handle('oleg', { live_shares: 1 }))).toBe('revoke its 1 public share first');
	});
});

describe('releaseWarning', () => {
	it('names the handle and says anyone may take it and publish at the old addresses', () => {
		expect(releaseWarning('tailarm')).toBe(
			'Release tailarm? It will no longer be reserved for you: anyone may take it, ' +
				'and a new holder could publish at addresses you once used.',
		);
	});
});

describe('defaultExpiresInDays', () => {
	it('is a year for a public share and 30 days for any other', () => {
		expect(defaultExpiresInDays('public')).toBe(DEFAULT_PUBLIC_EXPIRES_IN_DAYS);
		expect(DEFAULT_PUBLIC_EXPIRES_IN_DAYS).toBe(365);
		expect(defaultExpiresInDays('link')).toBe(DEFAULT_EXPIRES_IN_DAYS);
		expect(defaultExpiresInDays('named')).toBe(DEFAULT_EXPIRES_IN_DAYS);
	});
});

describe('formSlug', () => {
	it('follows the label until the owner edits it', () => {
		expect(formSlug({ label: 'Reachability boards', slug: '', slugEdited: false })).toBe('reachability-boards');
	});

	it('is what the owner typed once edited, whatever the label says', () => {
		expect(formSlug({ label: 'Reachability boards', slug: 'boards', slugEdited: true })).toBe('boards');
		expect(formSlug({ label: 'Reachability boards', slug: '', slugEdited: true })).toBe('');
	});
});

describe('withAudience', () => {
	it('sets the scope to read for a public share, which is read only', () => {
		const chosen = withAudience(form({ scope: 'play', seat: 'north' }), 'public');
		expect(chosen.audience).toBe('public');
		expect(chosen.scope).toBe('read');
	});

	it('leaves the scope alone for the other audiences', () => {
		expect(withAudience(form({ scope: 'play' }), 'named').scope).toBe('play');
		expect(withAudience(form({ audience: 'public', scope: 'read' }), 'link').scope).toBe('read');
	});

	it('moves an expiry still at the old default to the new audience\'s default', () => {
		expect(withAudience(form(), 'public').expiresInDays).toBe(365);
		expect(withAudience(form({ audience: 'public', expiresInDays: 365 }), 'link').expiresInDays).toBe(30);
		expect(withAudience(form(), 'named').expiresInDays).toBe(30);
	});

	it('keeps an expiry the owner typed, and an emptied one', () => {
		expect(withAudience(form({ expiresInDays: 7 }), 'public').expiresInDays).toBe(7);
		expect(withAudience(form({ expiresInDays: null }), 'public').expiresInDays).toBeNull();
	});

	it('keeps the rest of the form as it was', () => {
		const before = form({ label: 'boards', slug: 'b', slugEdited: true, memberEmail: 'ann@example.com' });
		expect(withAudience(before, 'public')).toEqual({ ...before, audience: 'public', expiresInDays: 365 });
	});
});

describe('payloadWarning', () => {
	it('warns a public share that anyone at its address sees token values', () => {
		expect(payloadWarning(form({ audience: 'public', publishPayloads: true }))).toBe(
			'Token values will be visible to anyone, at a public address.',
		);
	});

	it('warns a link share that anyone who has the link sees token values', () => {
		expect(payloadWarning(form({ audience: 'link', publishPayloads: true }))).toBe(
			'Token values will be visible to anyone who has the link.',
		);
	});

	it('says nothing more for a named share, whose one viewer the owner chooses', () => {
		expect(payloadWarning(form({ audience: 'named', publishPayloads: true }))).toBeNull();
	});

	it('says nothing while payloads are not published, whatever the audience', () => {
		expect(payloadWarning(form({ audience: 'public', publishPayloads: false }))).toBeNull();
		expect(payloadWarning(form({ audience: 'link', publishPayloads: false }))).toBeNull();
		expect(payloadWarning(form({ audience: 'named', publishPayloads: false }))).toBeNull();
	});
});

describe('worldProblem', () => {
	it('is null for a world on one worker and for a notebook', () => {
		expect(worldProblem(share())).toBeNull();
		expect(worldProblem(share({ resource_kind: 'notebook', notebook_id: 'nb-1', nets: [] }))).toBeNull();
	});

	it('says when every net has been deleted', () => {
		expect(worldProblem(share({ nets: [] }))).toBe('Its nets have all been deleted.');
	});

	it('says when a net has lost its worker', () => {
		const world = share({
			nets: [
				shareNet('net-a', W1),
				shareNet('net-b', null),
			],
		});
		expect(worldProblem(world)).toBe('A net of this world is on no worker now, so the world cannot be served.');
	});

	it('says when a reassignment split the world across workers', () => {
		const world = share({
			nets: [
				shareNet('net-a', W1),
				shareNet('net-b', W2),
			],
		});
		expect(worldProblem(world)).toBe('Its nets are on more than one worker now, so the world cannot be served.');
	});
});

describe('describeInputs', () => {
	it('names the places, then the controls', () => {
		expect(describeInputs({ play_places: ['moves', 'chat'], play_controls: ['resign'] })).toBe(
			'places moves, chat; controls resign',
		);
		expect(describeInputs({ play_places: ['orders'], play_controls: [] })).toBe('places orders');
		expect(describeInputs({ play_places: [], play_controls: ['go', 'stop'] })).toBe('controls go, stop');
	});

	it('is null for a net the share lists nothing on', () => {
		expect(describeInputs({ play_places: [], play_controls: [] })).toBeNull();
	});
});

describe('netsByWorker', () => {
	const workers = [
		{ id: W1, name: 'zeta' },
		{ id: W2, name: 'alpha' },
	];

	it('groups by worker, workers by name, nets by instance name, no worker last', () => {
		const groups = netsByWorker(
			[net('n1', W1, 'shop'), net('n2', null, 'loose'), net('n3', W2, 'light'), net('n4', W1, 'bank')],
			workers,
		);
		expect(groups.map((g) => [g.workerId, g.label, g.nets.map((n) => n.instance_name)])).toEqual([
			[W2, 'alpha', ['light']],
			[W1, 'zeta', ['bank', 'shop']],
			[null, 'no worker', ['loose']],
		]);
	});

	it('labels a worker the list does not know by the start of its id', () => {
		const [group] = netsByWorker([net('n1', 'abcdefgh-1234', 'shop')], []);
		expect(group.label).toBe('abcdefgh');
	});

	it('is empty for no nets', () => {
		expect(netsByWorker([], workers)).toEqual([]);
	});
});

describe('pickRefusal', () => {
	const nets = [net('n1', W1), net('n2', W1), net('n3', W2), net('n4', null)];

	it('refuses a net on no worker, picked or not', () => {
		expect(pickRefusal(null, new Set())).toBe(NO_WORKER_REASON);
		expect(pickRefusal(null, pickedWorkers(['n1'], nets))).toBe(NO_WORKER_REASON);
	});

	it('takes any net on a worker while nothing is picked', () => {
		expect(pickRefusal(W1, pickedWorkers([], nets))).toBeNull();
		expect(pickRefusal(W2, pickedWorkers([], nets))).toBeNull();
	});

	it('takes only nets on the picked nets\' worker', () => {
		const picked = pickedWorkers(['n1'], nets);
		expect(pickRefusal(W1, picked)).toBeNull();
		expect(pickRefusal(W2, picked)).toBe(OTHER_WORKER_REASON);
	});

	it('ignores a picked id the list no longer has', () => {
		expect(pickedWorkers(['gone'], nets)).toEqual(new Set());
	});

	it('reports every worker a stale pick spans', () => {
		expect(pickedWorkers(['n1', 'n3'], nets)).toEqual(new Set([W1, W2]));
	});
});

describe('togglePicked', () => {
	it('adds in picking order and removes', () => {
		expect(togglePicked(['a'], 'b', true)).toEqual(['a', 'b']);
		expect(togglePicked(['a', 'b'], 'a', false)).toEqual(['b']);
	});

	it('never lists a net twice', () => {
		expect(togglePicked(['a', 'b'], 'a', true)).toEqual(['b', 'a']);
	});
});

describe('parseNames', () => {
	it('splits on commas and trims each name', () => {
		expect(parseNames(' moves , chat,resign ')).toEqual(['moves', 'chat', 'resign']);
	});

	it('drops empty names and reads nothing from an empty or missing field', () => {
		expect(parseNames('moves,, ,chat,')).toEqual(['moves', 'chat']);
		expect(parseNames('')).toEqual([]);
		expect(parseNames(undefined)).toEqual([]);
	});

	it('keeps a nested net\'s path whole', () => {
		expect(parseNames('board/moves, chat')).toEqual(['board/moves', 'chat']);
	});
});

describe('emptyShareForm', () => {
	it('starts as the server\'s defaults: a read link world for 30 days, payloads hidden', () => {
		const empty = emptyShareForm();
		expect(empty).toMatchObject({
			resourceKind: 'world',
			scope: 'read',
			audience: 'link',
			publishPayloads: false,
			expiresInDays: 30,
			maxViewers: 20,
			inputsPerMinute: 60,
			bundleId: null,
			handle: null,
			slug: '',
			slugEdited: false,
		});
		expect([DEFAULT_EXPIRES_IN_DAYS, DEFAULT_MAX_VIEWERS, DEFAULT_INPUTS_PER_MINUTE]).toEqual([30, 20, 60]);
	});
});

describe('shareRequest', () => {
	it('sends a read link world with its nets and nothing a read link share would refuse', () => {
		expect(shareRequest(form({ netIds: ['net-a', 'net-b'], seat: 'north', memberEmail: 'ann@example.com' }))).toEqual({
			label: 'demo',
			resource_kind: 'world',
			nets: [{ net_id: 'net-a' }, { net_id: 'net-b' }],
			scope: 'read',
			audience: 'link',
			expires_in_days: 30,
			publish_payloads: false,
			max_viewers: 20,
			inputs_per_minute: 60,
		});
	});

	it('leaves the per-net lists off a read share even when the owner typed some', () => {
		const request = shareRequest(form({ playPlaces: { 'net-a': 'moves' }, playControls: { 'net-a': 'resign' } }));
		expect(request.nets).toEqual([{ net_id: 'net-a' }]);
	});

	it('sends a named play world with its seat, email and each net\'s lists', () => {
		const request = shareRequest(
			form({
				label: 'two-seat game',
				netIds: ['net-a', 'net-b'],
				scope: 'play',
				seat: 'north',
				playPlaces: { 'net-a': 'moves, chat', 'net-b': 'said' },
				playControls: { 'net-a': 'resign' },
				audience: 'named',
				memberEmail: 'ann@example.com',
				expiresInDays: 7,
				publishPayloads: true,
				maxViewers: 4,
				inputsPerMinute: 120,
			}),
		);
		expect(request).toEqual({
			label: 'two-seat game',
			resource_kind: 'world',
			nets: [
				{ net_id: 'net-a', play_places: ['moves', 'chat'], play_controls: ['resign'] },
				{ net_id: 'net-b', play_places: ['said'], play_controls: [] },
			],
			scope: 'play',
			seat: 'north',
			audience: 'named',
			member_email: 'ann@example.com',
			expires_in_days: 7,
			publish_payloads: true,
			max_viewers: 4,
			inputs_per_minute: 120,
		});
	});

	it('sends the picked bundle on a world of either scope', () => {
		expect(shareRequest(form({ bundleId: 'bundle-1' }))).toMatchObject({ resource_kind: 'world', bundle_id: 'bundle-1' });
		const play = shareRequest(form({ scope: 'play', seat: 'north', playPlaces: { 'net-a': 'moves' }, bundleId: 'bundle-1' }));
		expect(play).toMatchObject({ scope: 'play', bundle_id: 'bundle-1' });
	});

	it('leaves the bundle out when none is picked', () => {
		expect(shareRequest(form())).not.toHaveProperty('bundle_id');
	});

	it('leaves a picked bundle off a notebook share, which would refuse it', () => {
		const request = shareRequest(form({ resourceKind: 'notebook', notebookId: 'nb-1', bundleId: 'bundle-1' }));
		expect(request).not.toHaveProperty('bundle_id');
	});

	it('sends a notebook by id and no nets', () => {
		const request = shareRequest(form({ resourceKind: 'notebook', notebookId: 'nb-1', netIds: ['net-a'] }));
		expect(request.notebook_id).toBe('nb-1');
		expect(request).not.toHaveProperty('nets');
	});

	it('sends what the server refuses as typed, so its sentence is the answer', () => {
		expect(shareRequest(form({ label: '', netIds: [] }))).toMatchObject({ label: '', nets: [] });
		expect(shareRequest(form({ resourceKind: 'notebook', notebookId: null }))).toMatchObject({ notebook_id: null });
		expect(shareRequest(form({ scope: 'play', seat: '' }))).toMatchObject({ seat: '' });
		expect(shareRequest(form({ audience: 'named', memberEmail: '' }))).toMatchObject({ member_email: '' });
		expect(shareRequest(form({ expiresInDays: 0, maxViewers: 500, inputsPerMinute: 2.5 }))).toMatchObject({
			expires_in_days: 0,
			max_viewers: 500,
			inputs_per_minute: 2.5,
		});
	});

	it('sends a public share\'s handle and its slug, suggested by the label', () => {
		const request = shareRequest(
			form({
				label: 'Reachability boards',
				resourceKind: 'notebook',
				notebookId: 'nb-1',
				audience: 'public',
				handle: 'tailarm',
				expiresInDays: 365,
			}),
		);
		expect(request).toEqual({
			label: 'Reachability boards',
			resource_kind: 'notebook',
			notebook_id: 'nb-1',
			scope: 'read',
			audience: 'public',
			handle: 'tailarm',
			slug: 'reachability-boards',
			expires_in_days: 365,
			publish_payloads: false,
			max_viewers: 20,
			inputs_per_minute: 60,
		});
	});

	it('sends the slug the owner typed once edited, as typed', () => {
		const request = shareRequest(form({ audience: 'public', slug: ' Boards ', slugEdited: true }));
		expect(request.slug).toBe(' Boards ');
	});

	it('sends a public share with no handle chosen as it stands, for the server to refuse', () => {
		expect(shareRequest(form({ audience: 'public' }))).toMatchObject({ handle: null });
	});

	it('leaves the handle and slug off any share but a public one, which alone takes them', () => {
		for (const audience of ['link', 'named'] as const) {
			const request = shareRequest(form({ audience, handle: 'oleg', slug: 'boards', slugEdited: true }));
			expect(request).not.toHaveProperty('handle');
			expect(request).not.toHaveProperty('slug');
		}
	});

	it('leaves an emptied number out, so the server\'s default applies', () => {
		const request = shareRequest(form({ expiresInDays: null, maxViewers: null, inputsPerMinute: null }));
		expect(request).not.toHaveProperty('expires_in_days');
		expect(request).not.toHaveProperty('max_viewers');
		expect(request).not.toHaveProperty('inputs_per_minute');
	});
});

describe('withoutToken', () => {
	it('drops the secret and keeps the rest', () => {
		const created: ShareCreated = { ...share(), token: 'petri_share_secret' };
		const listed = withoutToken(created);
		expect(listed).toEqual(share());
		expect(listed).not.toHaveProperty('token');
	});
});

describe('formatBundleSize', () => {
	it('shows megabytes, millions of bytes, to one decimal', () => {
		expect(formatBundleSize(12_345_678)).toBe('12.3 MB');
		expect(formatBundleSize(28_600_000)).toBe('28.6 MB');
		expect(formatBundleSize(268_435_456)).toBe('268.4 MB');
		expect(formatBundleSize(1_000_000)).toBe('1.0 MB');
		expect(formatBundleSize(50_000)).toBe('0.1 MB');
	});

	it('says a small bundle is under 0.1 MB rather than none', () => {
		expect(formatBundleSize(1)).toBe('under 0.1 MB');
		expect(formatBundleSize(49_999)).toBe('under 0.1 MB');
	});

	it('shows an empty bundle as 0.0 MB', () => {
		expect(formatBundleSize(0)).toBe('0.0 MB');
	});
});

describe('bundleFileRefusal', () => {
	it('is the server\'s 413 sentence for a zip over 64 MiB', () => {
		expect(MAX_BUNDLE_ZIP_BYTES).toBe(67_108_864);
		expect(BUNDLE_TOO_LARGE).toBe("A bundle's zip is at most 64 MiB.");
		expect(bundleFileRefusal(MAX_BUNDLE_ZIP_BYTES + 1)).toBe(BUNDLE_TOO_LARGE);
		expect(bundleFileRefusal(200_000_000)).toBe(BUNDLE_TOO_LARGE);
	});

	it('is null up to 64 MiB, which the server reads', () => {
		expect(bundleFileRefusal(MAX_BUNDLE_ZIP_BYTES)).toBeNull();
		expect(bundleFileRefusal(1_500_000)).toBeNull();
		expect(bundleFileRefusal(0)).toBeNull();
	});
});
