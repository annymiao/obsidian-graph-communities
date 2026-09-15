export const TRANSMISSION_REVIEW_MODES = [
	'required',
	'trusted-local',
	'disabled',
] as const;

export type TransmissionReviewMode = typeof TRANSMISSION_REVIEW_MODES[number];
export type KnowledgeTransport = 'stdio' | 'http';

export function readTransmissionReviewMode(
	value: string | undefined,
): TransmissionReviewMode {
	const normalized = value?.trim() || 'required';
	if ((TRANSMISSION_REVIEW_MODES as readonly string[]).includes(normalized)) {
		return normalized as TransmissionReviewMode;
	}
	throw new Error(
		`OBSIDIAN_TRANSMISSION_REVIEW must be one of: ${TRANSMISSION_REVIEW_MODES.join(', ')}.`,
	);
}

/**
 * `trusted-local` is intentionally limited to STDIO. An HTTP MCP connection can
 * arrive through a loopback tunnel, so its apparent peer address is not proof
 * that the caller is on this computer.
 */
export function requiresTransmissionReview(
	mode: TransmissionReviewMode,
	transport: KnowledgeTransport,
): boolean {
	if (mode === 'disabled') return false;
	if (mode === 'trusted-local') return transport !== 'stdio';
	return true;
}
