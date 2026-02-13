<script lang="ts">
	type Props = {
		githubConnected: boolean;
		hasRepos: boolean;
		hasSuccessfulBuild: boolean;
		hasWorkers: boolean;
		hasReadyWorker: boolean;
		hasLoadedNet: boolean;
	};

	let {
		githubConnected,
		hasRepos,
		hasSuccessfulBuild,
		hasWorkers,
		hasReadyWorker,
		hasLoadedNet,
	}: Props = $props();

	interface Step {
		label: string;
		description: string;
		done: boolean;
		link?: string;
	}

	let steps = $derived<Step[]>([
		{
			label: 'Connect GitHub',
			description: 'Link your GitHub account to access repositories.',
			done: githubConnected,
			link: '/settings',
		},
		{
			label: 'Connect a repository',
			description: 'Add a GitHub repository containing your Petri net code.',
			done: hasRepos,
			link: '/deployments',
		},
		{
			label: 'Build your code',
			description: 'Trigger a build to create a deployable image from your repo.',
			done: hasSuccessfulBuild,
			link: '/deployments',
		},
		{
			label: 'Create a worker',
			description: 'Create a worker that will run your Petri net.',
			done: hasWorkers,
			link: '/workers',
		},
		{
			label: 'Provision the worker',
			description: 'Provision the worker so it is ready to accept nets.',
			done: hasReadyWorker,
			link: '/workers',
		},
		{
			label: 'Select a net and load it',
			description: 'Choose a net above, assign a worker, and load it.',
			done: hasLoadedNet,
		},
	]);

	let currentStepIndex = $derived(steps.findIndex(s => !s.done));
</script>

<div class="w-full max-w-[480px]">
	<h2 class="text-lg font-semibold text-foreground mb-1">Get started</h2>
	<p class="text-sm text-foreground-muted mb-5">Complete these steps to run your first Petri net.</p>

	<ol class="list-none m-0 p-0 flex flex-col gap-1">
		{#each steps as step, i}
			{@const isCurrent = i === currentStepIndex}
			{@const isFuture = i > currentStepIndex && currentStepIndex >= 0}
			<li
				class="flex items-start gap-3 px-4 py-3 rounded-md transition-colors {isCurrent ? 'bg-card border border-accent' : 'border border-transparent'}"
				class:opacity-50={isFuture}
			>
				<!-- Status indicator -->
				<span class="flex items-center justify-center w-6 h-6 rounded-full shrink-0 mt-0.5 text-xs font-bold
					{step.done ? 'bg-status-success-bg text-status-success' : isCurrent ? 'bg-accent text-accent-foreground' : 'bg-muted text-foreground-muted'}"
				>
					{#if step.done}
						&#10003;
					{:else}
						{i + 1}
					{/if}
				</span>

				<!-- Content -->
				<div class="flex-1 min-w-0">
					<span class="text-sm font-medium {step.done ? 'text-foreground-muted line-through' : 'text-foreground'}">
						{step.label}
					</span>
					{#if isCurrent}
						<p class="text-xs text-foreground-muted mt-0.5 mb-0">{step.description}</p>
						{#if step.link}
							<a
								href={step.link}
								class="inline-block mt-2 px-3 py-1.5 border border-accent rounded bg-accent text-accent-foreground text-xs font-medium no-underline transition-opacity hover:opacity-90"
							>
								Go to {step.label.toLowerCase().includes('github') ? 'Settings' : step.label.toLowerCase().includes('repo') || step.label.toLowerCase().includes('build') ? 'Deployments' : 'Workers'}
							</a>
						{/if}
					{/if}
				</div>
			</li>
		{/each}
	</ol>
</div>
