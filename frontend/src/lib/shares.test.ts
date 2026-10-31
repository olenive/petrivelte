import { describe, expect, it } from 'vitest';
import type { Share, ShareCreated, ShareNet, WiringNet } from './api';
import {
	BUNDLE_TOO_LARGE,
	DEFAULT_EXPIRES_IN_DAYS,
	DEFAULT_INPUTS_PER_MINUTE,
	DEFAULT_MAX_VIEWERS,
	MAX_BUNDLE_ZIP_BYTES,
	NO_WORKER_REASON,
	OTHER_WORKER_REASON,
	bundleFileRefusal,
	describeInputs,
	emptyShareForm,
	formatBundleSize,
	netsByWorker,
	parseNames,
	pickRefusal,
	pickedWorkers,
	shareLink,
	shareLinkBase,
	shareRequest,
	shareStatus,
	shareTokenLabel,
	togglePicked,
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
