import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	collectTransmissionReview,
	getTransmissionReviewDraft,
	startTransmissionReview,
	submitTransmissionReview,
	TransmissionReviewCancelledError,
} from '../src/transmissionReview.js';

const reviewOptions = {
	title: 'Obsidian → Codex 传输审核',
	description: '确认前 Codex 看不到正文。',
	content: '# 尚未发送的原始内容\n\nprivate-before-approval',
};

test('keeps draft behind a separate UI token and releases edited text exactly once', async () => {
	const ticket = await startTransmissionReview(reviewOptions);

	assert.equal(ticket.status, 'pending');
	assert.match(ticket.reviewId, /^[a-f0-9]{64}$/);
	assert.match(ticket.uiToken, /^[a-f0-9]{64}$/);
	assert.notEqual(ticket.reviewId, ticket.uiToken);
	assert.equal(JSON.stringify({
		status: ticket.status,
		reviewId: ticket.reviewId,
		message: ticket.message,
	}).includes('private-before-approval'), false);

	const pending = await collectTransmissionReview(ticket.reviewId, 5);
	assert.equal(pending.status, 'pending');
	assert.equal(JSON.stringify(pending).includes('private-before-approval'), false);

	assert.throws(
		() => getTransmissionReviewDraft(ticket.reviewId, '0'.repeat(64)),
		/审核授权无效/,
	);
	const draft = getTransmissionReviewDraft(ticket.reviewId, ticket.uiToken);
	assert.equal(draft.content, reviewOptions.content);

	const edited = '# 用户审核后的内容\n\n只允许这段文字返回给 Codex。';
	const decision = submitTransmissionReview(
		ticket.reviewId,
		ticket.uiToken,
		'approve',
		edited,
	);
	assert.equal(decision.status, 'approved');
	assert.throws(
		() => getTransmissionReviewDraft(ticket.reviewId, ticket.uiToken),
		/审核授权无效/,
	);

	const approved = await collectTransmissionReview(ticket.reviewId, 1_000);
	assert.equal(approved.status, 'approved');
	if (approved.status === 'approved') assert.equal(approved.content, edited);
	await assert.rejects(
		collectTransmissionReview(ticket.reviewId),
		/审核编号不存在或已经使用/,
	);
});

test('cancelling the in-Codex review returns no content', async () => {
	const ticket = await startTransmissionReview(reviewOptions);
	const decision = submitTransmissionReview(ticket.reviewId, ticket.uiToken, 'cancel');
	assert.equal(decision.status, 'cancelled');
	await assert.rejects(
		collectTransmissionReview(ticket.reviewId, 1_000),
		TransmissionReviewCancelledError,
	);
});

test('approval rejects empty and oversized content without releasing the draft', async () => {
	const ticket = await startTransmissionReview(reviewOptions);
	assert.throws(
		() => submitTransmissionReview(ticket.reviewId, ticket.uiToken, 'approve', '   '),
		/内容不能为空/,
	);
	const pending = await collectTransmissionReview(ticket.reviewId);
	assert.equal(pending.status, 'pending');
	submitTransmissionReview(ticket.reviewId, ticket.uiToken, 'cancel');
	await assert.rejects(collectTransmissionReview(ticket.reviewId), TransmissionReviewCancelledError);
});
