import {
	CONTROLLED_WRITE_PROTOCOL_VERSION,
	type CapabilityNegotiation,
	type ModelWriteCapabilities,
	type WriteCapability,
	type WriteCapabilityManifest,
} from '../write/contracts.js';
import { assertNonEmptyText } from '../write/integrity.js';

export const CORE_WRITE_CAPABILITIES: readonly WriteCapability[] = [
	'proposal.correction',
	'proposal.create',
	'proposal.delete',
	'diff.structured',
	'approval.bound-token',
	'write.cas',
	'write.atomic',
	'write.rollback',
	'audit.hash-chain',
	'reingest.await-searchable',
] as const;

export function createWriteCapabilityManifest(
	serverId: string,
	options: { supported?: WriteCapability[]; maxProposalBytes?: number } = {},
): WriteCapabilityManifest {
	assertNonEmptyText(serverId, 'capability serverId', 256);
	const supported = uniqueCapabilities(options.supported ?? [...CORE_WRITE_CAPABILITIES]);
	const maxProposalBytes = options.maxProposalBytes ?? 8 * 1024 * 1024;
	if (!Number.isSafeInteger(maxProposalBytes) || maxProposalBytes <= 0) {
		throw new TypeError('maxProposalBytes must be a positive safe integer.');
	}
	return {
		protocolVersion: CONTROLLED_WRITE_PROTOCOL_VERSION,
		serverId,
		supported,
		maxProposalBytes,
		approvalRequired: true,
	};
}

/** A model-neutral handshake; no provider-specific fields affect authorization. */
export function negotiateWriteCapabilities(
	client: ModelWriteCapabilities,
	server: WriteCapabilityManifest,
): CapabilityNegotiation {
	if (
		client.protocolVersion !== CONTROLLED_WRITE_PROTOCOL_VERSION
		|| server.protocolVersion !== CONTROLLED_WRITE_PROTOCOL_VERSION
	) {
		return {
			accepted: false,
			protocolVersion: CONTROLLED_WRITE_PROTOCOL_VERSION,
			common: [],
			missingRequired: uniqueCapabilities(client.required),
			server,
		};
	}
	assertNonEmptyText(client.client.clientId, 'capability clientId', 256);
	const supported = uniqueCapabilities(client.supported);
	const required = uniqueCapabilities(client.required);
	const serverSet = new Set(server.supported);
	const clientSet = new Set(supported);
	const common = supported.filter((capability) => serverSet.has(capability));
	const missingRequired = required.filter(
		(capability) => !clientSet.has(capability) || !serverSet.has(capability),
	);
	return {
		accepted: missingRequired.length === 0,
		protocolVersion: CONTROLLED_WRITE_PROTOCOL_VERSION,
		common,
		missingRequired,
		server,
	};
}

function uniqueCapabilities(capabilities: WriteCapability[]): WriteCapability[] {
	const allowed = new Set<WriteCapability>(CORE_WRITE_CAPABILITIES);
	const result: WriteCapability[] = [];
	for (const capability of capabilities) {
		if (!allowed.has(capability)) throw new TypeError(`Unknown write capability: ${capability}`);
		if (!result.includes(capability)) result.push(capability);
	}
	return result;
}
