import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	readTransmissionReviewMode,
	requiresTransmissionReview,
} from '../src/reviewPolicy.js';

test('transmission review defaults to required and rejects ambiguous values', () => {
	assert.equal(readTransmissionReviewMode(undefined), 'required');
	assert.equal(readTransmissionReviewMode(' trusted-local '), 'trusted-local');
	assert.throws(
		() => readTransmissionReviewMode('DISABLED'),
		/OBSIDIAN_TRANSMISSION_REVIEW must be one of/u,
	);
	assert.throws(
		() => readTransmissionReviewMode('false'),
		/OBSIDIAN_TRANSMISSION_REVIEW must be one of/u,
	);
});

test('trusted-local bypasses only STDIO while disabled is an explicit global bypass', () => {
	assert.equal(requiresTransmissionReview('required', 'stdio'), true);
	assert.equal(requiresTransmissionReview('required', 'http'), true);
	assert.equal(requiresTransmissionReview('trusted-local', 'stdio'), false);
	assert.equal(requiresTransmissionReview('trusted-local', 'http'), true);
	assert.equal(requiresTransmissionReview('disabled', 'stdio'), false);
	assert.equal(requiresTransmissionReview('disabled', 'http'), false);
});
