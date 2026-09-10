import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_REVIEW_BYTES = 1_000_000;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1_000;
const REVIEW_RESULT_RETENTION_MS = 10 * 60 * 1_000;
const MAX_ACTIVE_REVIEWS = 8;

export interface TransmissionReviewOptions {
	title: string;
	description: string;
	content: string;
}

export interface TransmissionReviewTicket {
	reviewId: string;
	uiToken: string;
	status: 'pending';
	message: string;
}

export interface TransmissionReviewDraft {
	reviewId: string;
	title: string;
	description: string;
	content: string;
	expiresAt: string;
}

export type TransmissionReviewCollection =
	| {
		reviewId: string;
		status: 'pending';
		message: string;
	}
	| {
		reviewId: string;
		status: 'approved';
		content: string;
	};

export type TransmissionReviewDecision = {
	reviewId: string;
	status: 'approved' | 'cancelled';
	message: string;
};

export class TransmissionReviewCancelledError extends Error {
	constructor(message = '用户取消了本次 Obsidian 信息传输；没有向 Codex 返回笔记内容。') {
		super(message);
		this.name = 'TransmissionReviewCancelledError';
	}
}

type StoredReviewStatus = 'pending' | 'approved' | 'cancelled' | 'failed';

interface StoredReview {
	reviewId: string;
	uiToken: string;
	title: string;
	description: string;
	status: StoredReviewStatus;
	content: string;
	error: Error | null;
	expiresAt: number;
	settled: Promise<void>;
	markSettled: () => void;
	cleanupTimer: NodeJS.Timeout | null;
}

const activeReviews = new Map<string, StoredReview>();

export async function startTransmissionReview(
	options: TransmissionReviewOptions,
): Promise<TransmissionReviewTicket> {
	const activeCount = [...activeReviews.values()].filter((review) => review.status === 'pending').length;
	if (activeCount >= MAX_ACTIVE_REVIEWS) {
		throw new Error('已有过多待处理的 Obsidian 审核面板；请先完成或取消其中一个。没有向 Codex 返回笔记内容。');
	}
	if (Buffer.byteLength(options.content, 'utf8') > MAX_REVIEW_BYTES) {
		throw new Error('审核内容超过允许大小；没有向 Codex 返回笔记内容。');
	}

	const reviewId = randomBytes(32).toString('hex');
	const uiToken = randomBytes(32).toString('hex');
	let markSettled: () => void = () => undefined;
	const settled = new Promise<void>((resolve) => {
		markSettled = resolve;
	});
	const stored: StoredReview = {
		reviewId,
		uiToken,
		title: options.title,
		description: options.description,
		status: 'pending',
		content: options.content,
		error: null,
		expiresAt: Date.now() + REVIEW_TIMEOUT_MS,
		settled,
		markSettled,
		cleanupTimer: null,
	};
	activeReviews.set(reviewId, stored);
	stored.cleanupTimer = setTimeout(() => expireStoredReview(stored), REVIEW_TIMEOUT_MS);
	stored.cleanupTimer.unref();

	return {
		reviewId,
		uiToken,
		status: 'pending',
		message: 'Codex 右侧审核面板已准备。确认前模型未收到任何 Vault 正文。',
	};
}

export function getTransmissionReviewDraft(
	reviewId: string,
	uiToken: string,
): TransmissionReviewDraft {
	const stored = requireAuthorizedReview(reviewId, uiToken);
	if (stored.status !== 'pending') {
		throw new Error('本次审核已经结束，不能再次读取草稿。');
	}
	return {
		reviewId,
		title: stored.title,
		description: stored.description,
		content: stored.content,
		expiresAt: new Date(stored.expiresAt).toISOString(),
	};
}

export function submitTransmissionReview(
	reviewId: string,
	uiToken: string,
	action: 'approve' | 'cancel',
	content = '',
): TransmissionReviewDecision {
	const stored = requireAuthorizedReview(reviewId, uiToken);
	if (stored.status !== 'pending') {
		throw new Error('本次审核已经结束，不能重复提交。');
	}

	if (action === 'approve') {
		if (!content.trim()) {
			throw new Error('审核后的内容不能为空。');
		}
		if (Buffer.byteLength(content, 'utf8') > MAX_REVIEW_BYTES) {
			throw new Error('审核后的内容超过允许大小。');
		}
		stored.status = 'approved';
		stored.content = content;
	} else {
		stored.status = 'cancelled';
		stored.content = '';
	}

	stored.uiToken = '';
	stored.markSettled();
	scheduleStoredReviewCleanup(stored);
	return {
		reviewId,
		status: stored.status,
		message: stored.status === 'approved'
			? '已确认。审核后的内容现在可以由 Codex 领取。'
			: '已取消。本次没有向 Codex 发送 Obsidian 正文。',
	};
}

export async function collectTransmissionReview(
	reviewId: string,
	waitMilliseconds = 0,
): Promise<TransmissionReviewCollection> {
	const stored = activeReviews.get(reviewId);
	if (!stored) {
		throw new Error('审核编号不存在或已经使用；没有向 Codex 返回笔记内容。');
	}

	if (stored.status === 'pending' && waitMilliseconds > 0) {
		await waitForSettlement(stored.settled, waitMilliseconds);
	}
	if (stored.status === 'pending') {
		return {
			reviewId,
			status: 'pending',
			message: '仍在等待右侧审核面板确认。Codex 模型尚未收到任何 Vault 正文。',
		};
	}

	if (stored.status === 'cancelled') {
		forgetStoredReview(stored);
		throw new TransmissionReviewCancelledError();
	}
	if (stored.status === 'failed') {
		const error = stored.error ?? new Error('Obsidian 传输审核失败；没有向 Codex 返回笔记内容。');
		forgetStoredReview(stored);
		throw error;
	}
	const content = stored.content.trim();
	forgetStoredReview(stored);
	if (!content) {
		throw new TransmissionReviewCancelledError('审核后的内容为空；没有向 Codex 返回笔记内容。');
	}
	return { reviewId, status: 'approved', content };
}

function requireAuthorizedReview(reviewId: string, uiToken: string): StoredReview {
	const stored = activeReviews.get(reviewId);
	if (!stored || !safeTokenEqual(stored.uiToken, uiToken)) {
		throw new Error('审核授权无效或已经过期；没有向 Codex 返回笔记内容。');
	}
	return stored;
}

function safeTokenEqual(expected: string, received: string): boolean {
	if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(received)) return false;
	return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

function expireStoredReview(stored: StoredReview): void {
	if (activeReviews.get(stored.reviewId) !== stored || stored.status !== 'pending') return;
	stored.status = 'failed';
	stored.uiToken = '';
	stored.content = '';
	stored.error = new Error('Obsidian 传输审核已超时；没有向 Codex 返回笔记内容。');
	stored.markSettled();
	scheduleStoredReviewCleanup(stored);
}

function scheduleStoredReviewCleanup(stored: StoredReview): void {
	if (stored.cleanupTimer) clearTimeout(stored.cleanupTimer);
	stored.cleanupTimer = setTimeout(() => forgetStoredReview(stored), REVIEW_RESULT_RETENTION_MS);
	stored.cleanupTimer.unref();
}

function forgetStoredReview(stored: StoredReview): void {
	if (stored.cleanupTimer) clearTimeout(stored.cleanupTimer);
	stored.cleanupTimer = null;
	stored.uiToken = '';
	stored.content = '';
	if (activeReviews.get(stored.reviewId) === stored) {
		activeReviews.delete(stored.reviewId);
	}
}

async function waitForSettlement(settled: Promise<void>, waitMilliseconds: number): Promise<void> {
	let timer: NodeJS.Timeout | null = null;
	try {
		await Promise.race([
			settled,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, Math.max(0, waitMilliseconds));
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
