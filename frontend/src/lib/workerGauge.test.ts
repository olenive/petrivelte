import { describe, expect, it } from 'vitest';

import { gaugeReading, type GaugeWorker } from './workerGauge';
import type { WorkerMemorySnapshot } from './stores/workerMemory';

const worker = (overrides: Partial<GaugeWorker> = {}): GaugeWorker => ({
	status: 'ready',
	memory_mb: 2048,
	memory_used_mb: 110,
	memory_peak_mb: 140,
	...overrides,
});

const snapshot = (overrides: Partial<WorkerMemorySnapshot> = {}): WorkerMemorySnapshot => ({
	parent_rss_mb: 100,
	parent_peak_rss_mb: 120,
	container_total_mb: 1000,
	container_available_mb: 500,
	nets: [{ net_id: 'n1', pid: 2, rss_mb: 50, peak_rss_mb: 60 }],
	notebooks: [{ notebook_id: 'b1', definition_name: null, pid: 3, rss_mb: 200, peak_rss_mb: 210 }],
	...overrides,
});

describe('gaugeReading', () => {
	const cases: Array<{
		name: string;
		snap: WorkerMemorySnapshot | undefined;
		w: GaugeWorker;
		want: ReturnType<typeof gaugeReading>;
	}> = [
		{
			name: 'a snapshot wins over the worker list, notebooks included',
			snap: snapshot(),
			w: worker(),
			want: { source: 'snapshot', usedMb: 350, limitMb: 1000, percent: 35, peakMb: null },
		},
		{
			name: 'a snapshot without a container total falls back to the machine size',
			snap: snapshot({ container_total_mb: null, notebooks: undefined }),
			w: worker({ memory_mb: 300 }),
			want: { source: 'snapshot', usedMb: 150, limitMb: 300, percent: 50, peakMb: null },
		},
		{
			name: 'a snapshot is shown even with no health-check figure',
			snap: snapshot(),
			w: worker({ memory_used_mb: null }),
			want: { source: 'snapshot', usedMb: 350, limitMb: 1000, percent: 35, peakMb: null },
		},
		{
			name: 'no snapshot yet: the worker list seeds the gauge',
			snap: undefined,
			w: worker({ memory_mb: 1000, memory_used_mb: 110, memory_peak_mb: 140 }),
			want: { source: 'health_check', usedMb: 110, limitMb: 1000, percent: 11, peakMb: 140 },
		},
		{
			name: 'a seed without a peak says so',
			snap: undefined,
			w: worker({ memory_mb: 1000, memory_used_mb: 250, memory_peak_mb: null }),
			want: { source: 'health_check', usedMb: 250, limitMb: 1000, percent: 25, peakMb: null },
		},
		{
			name: 'an older control plane that sends no figure shows no gauge',
			snap: undefined,
			w: worker({ memory_used_mb: undefined, memory_peak_mb: undefined }),
			want: null,
		},
		{
			name: 'a worker never health-checked shows no gauge',
			snap: undefined,
			w: worker({ memory_used_mb: null }),
			want: null,
		},
		{
			name: 'a worker that is not ready shows no seed',
			snap: undefined,
			w: worker({ status: 'stopped' }),
			want: null,
		},
		{
			name: 'the percentage is capped at 100',
			snap: undefined,
			w: worker({ memory_mb: 100, memory_used_mb: 150 }),
			want: { source: 'health_check', usedMb: 150, limitMb: 100, percent: 100, peakMb: 140 },
		},
		{
			name: 'a zero limit reads 0 per cent rather than dividing by it',
			snap: snapshot({ container_total_mb: 0 }),
			w: worker(),
			want: { source: 'snapshot', usedMb: 350, limitMb: 0, percent: 0, peakMb: null },
		},
	];

	for (const { name, snap, w, want } of cases) {
		it(name, () => {
			expect(gaugeReading(snap, w)).toEqual(want);
		});
	}
});
