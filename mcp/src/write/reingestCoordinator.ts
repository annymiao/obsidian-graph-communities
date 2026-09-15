import type { VersionId } from '../stableIds.js';
import type {
	ReingestDriver,
	ReingestObservation,
	ReingestOutcome,
	SourceRef,
} from './contracts.js';

export interface ReingestCoordinatorOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
	clock?: () => number;
	delay?: (milliseconds: number) => Promise<void>;
}

/** Bridges a committed source write to the index and waits for visibility. */
export class ReingestCoordinator {
	private readonly timeoutMs: number;
	private readonly pollIntervalMs: number;
	private readonly clock: () => number;
	private readonly delay: (milliseconds: number) => Promise<void>;

	constructor(
		private readonly driver: ReingestDriver,
		options: ReingestCoordinatorOptions = {},
	) {
		this.timeoutMs = options.timeoutMs ?? 5_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 25;
		this.clock = options.clock ?? Date.now;
		this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => {
			setTimeout(resolve, milliseconds);
		}));
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) {
			throw new TypeError('Reingest timeoutMs must be an integer from 1 to 60000.');
		}
		if (
			!Number.isSafeInteger(this.pollIntervalMs)
			|| this.pollIntervalMs <= 0
			|| this.pollIntervalMs > this.timeoutMs
		) {
			throw new TypeError('Reingest pollIntervalMs must be positive and no greater than timeoutMs.');
		}
	}

	async commitAndAwait(
		source: SourceRef,
		expectedVersionId: VersionId | null,
	): Promise<ReingestOutcome> {
		const startedAt = this.clock();
		const expectedState = expectedVersionId === null ? 'absent' : 'present';
		let attempts = 0;
		let lastObservation: ReingestObservation | null = null;
		try {
			await this.driver.requestReingest(source);
		} catch (error) {
			return {
				expectedState,
				observedState: 'unknown',
				expectedVersionId,
				versionId: null,
				searchable: false,
				timedOut: false,
				attempts,
				elapsedMs: Math.max(0, this.clock() - startedAt),
				error: safeErrorMessage(error),
			};
		}

		while (true) {
			attempts += 1;
			try {
				lastObservation = await this.driver.observe(source);
				if (lastObservation) assertObservation(lastObservation);
			} catch (error) {
				return {
					expectedState,
					observedState: lastObservation?.state ?? 'unknown',
					expectedVersionId,
					versionId: lastObservation?.versionId ?? null,
					searchable: false,
					timedOut: false,
					attempts,
					elapsedMs: Math.max(0, this.clock() - startedAt),
					error: safeErrorMessage(error),
				};
			}
			if (
				lastObservation
				&& lastObservation.state === expectedState
				&& lastObservation.versionId === expectedVersionId
				&& lastObservation.searchable
			) {
				return observationOutcome(
					expectedState,
					expectedVersionId,
					lastObservation,
					false,
					attempts,
					Math.max(0, this.clock() - startedAt),
				);
			}
			const elapsedMs = Math.max(0, this.clock() - startedAt);
			if (elapsedMs >= this.timeoutMs) {
				return observationOutcome(
					expectedState,
					expectedVersionId,
					lastObservation,
					true,
					attempts,
					elapsedMs,
				);
			}
			await this.delay(Math.min(this.pollIntervalMs, this.timeoutMs - elapsedMs));
		}
	}
}

function observationOutcome(
	expectedState: 'present' | 'absent',
	expectedVersionId: VersionId | null,
	observation: ReingestObservation | null,
	timedOut: boolean,
	attempts: number,
	elapsedMs: number,
): ReingestOutcome {
	const observedState: ReingestOutcome['observedState'] = observation?.state ?? 'unknown';
	const base: ReingestOutcome = {
		expectedState,
		observedState,
		expectedVersionId,
		versionId: observation?.versionId ?? null,
		searchable: observation?.searchable ?? false,
		timedOut,
		attempts,
		elapsedMs,
	};
	return observation?.generationId === undefined
		? base
		: { ...base, generationId: observation.generationId };
}

function assertObservation(observation: ReingestObservation): void {
	if (observation.state === 'present' && observation.versionId === null) {
		throw new TypeError('A present reingest observation requires versionId.');
	}
	if (observation.state === 'absent' && observation.versionId !== null) {
		throw new TypeError('An absent reingest observation must not contain versionId.');
	}
}

function safeErrorMessage(error: unknown): string {
	if (!(error instanceof Error)) return 'unknown reingest error';
	const code = (error as NodeJS.ErrnoException).code;
	return code ? `${error.name}:${code}` : error.name || 'reingest error';
}
