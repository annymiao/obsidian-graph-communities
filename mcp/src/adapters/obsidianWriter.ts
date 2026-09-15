import type { SourceId } from '../stableIds.js';
import {
	type AdapterCommitRequest,
	type AdapterCommitResult,
	type AdapterRollbackRequest,
	type AdapterRollbackResult,
	type BaseVersion,
	type DocumentSnapshot,
	type SourceRef,
	type WritableSourceAdapter,
	type WriteOperation,
} from '../write/contracts.js';
import { canonicalJson } from '../write/integrity.js';
import { createDocumentSnapshot } from '../write/proposal.js';

/**
 * Injection boundary implemented by the Obsidian plugin process. It deliberately
 * contains no import from the `obsidian` package, so the MCP package stays reusable.
 */
export interface ObsidianWriteBridge {
	read(documentPath: string): Promise<string | null>;
	compareAndSwap(input: {
		transactionId: string;
		documentPath: string;
		operation: WriteOperation;
		expectedBase: BaseVersion | null;
		afterContent: string | null;
	}): Promise<{ rollbackToken: string; committedAt?: string }>;
	rollback(input: {
		transactionId: string;
		originalTransactionId: string;
		documentPath: string;
		rollbackToken: string;
		expectedCurrentVersion: BaseVersion | null;
	}): Promise<{ rolledBackAt?: string }>;
}

export interface InjectableObsidianWriterAdapterOptions {
	adapterId: string;
	sourceId: SourceId;
	bridge: ObsidianWriteBridge;
	supportedOperations?: WriteOperation[];
}

export class InjectableObsidianWriterAdapter implements WritableSourceAdapter {
	readonly adapterId: string;
	readonly sourceId: SourceId;
	readonly supportedOperations: ReadonlySet<WriteOperation>;
	private readonly bridge: ObsidianWriteBridge;

	constructor(options: InjectableObsidianWriterAdapterOptions) {
		this.adapterId = options.adapterId;
		this.sourceId = options.sourceId;
		this.bridge = options.bridge;
		this.supportedOperations = new Set(options.supportedOperations ?? ['create', 'replace', 'delete']);
		if (!this.adapterId || !this.sourceId) throw new TypeError('Obsidian adapter identity is required.');
	}

	async inspect(source: SourceRef): Promise<DocumentSnapshot | null> {
		this.assertSource(source);
		const content = await this.bridge.read(source.documentPath);
		return content === null ? null : createDocumentSnapshot(source, content);
	}

	async commit(request: AdapterCommitRequest): Promise<AdapterCommitResult> {
		const { plan } = request;
		this.assertSource(plan.source);
		this.assertSupported(plan.operation);
		const before = await this.inspect(plan.source);
		assertSameVersion(before?.baseVersion ?? null, plan.expectedBase, 'Obsidian bridge precondition');
		const result = await this.bridge.compareAndSwap({
			transactionId: request.transactionId,
			documentPath: plan.source.documentPath,
			operation: plan.operation,
			expectedBase: plan.expectedBase,
			afterContent: plan.afterContent,
		});
		if (!result.rollbackToken) throw new Error('Obsidian bridge did not return a rollback token.');
		const after = await this.inspect(plan.source);
		assertSameVersion(after?.baseVersion ?? null, plan.desiredVersion, 'Obsidian bridge postcondition');
		return {
			transactionId: request.transactionId,
			source: plan.source,
			operation: plan.operation,
			previousVersion: before?.baseVersion ?? null,
			committedVersion: after?.baseVersion ?? null,
			rollbackToken: result.rollbackToken,
			committedAt: result.committedAt ?? new Date().toISOString(),
		};
	}

	async rollback(request: AdapterRollbackRequest): Promise<AdapterRollbackResult> {
		this.assertSource(request.source);
		const current = await this.inspect(request.source);
		assertSameVersion(
			current?.baseVersion ?? null,
			request.expectedCurrentVersion,
			'Obsidian rollback precondition',
		);
		const result = await this.bridge.rollback({
			transactionId: request.transactionId,
			originalTransactionId: request.originalTransactionId,
			documentPath: request.source.documentPath,
			rollbackToken: request.rollbackToken,
			expectedCurrentVersion: request.expectedCurrentVersion,
		});
		const restored = await this.inspect(request.source);
		return {
			transactionId: request.transactionId,
			source: request.source,
			restoredVersion: restored?.baseVersion ?? null,
			rolledBackAt: result.rolledBackAt ?? new Date().toISOString(),
		};
	}

	private assertSource(source: SourceRef): void {
		if (source.adapterId !== this.adapterId || source.sourceId !== this.sourceId) {
			throw new Error('SourceRef is not owned by this Obsidian adapter.');
		}
	}

	private assertSupported(operation: WriteOperation): void {
		if (!this.supportedOperations.has(operation)) {
			throw new Error(`Obsidian adapter does not support ${operation}.`);
		}
	}
}

function assertSameVersion(
	actual: BaseVersion | null,
	expected: BaseVersion | null,
	label: string,
): void {
	if (canonicalJson(actual) !== canonicalJson(expected)) {
		throw new Error(`${label} failed because the document version changed.`);
	}
}
