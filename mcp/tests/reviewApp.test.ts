import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	MCP_APP_MIME_TYPE,
	REVIEW_APP_URI,
	renderTransmissionReviewApp,
} from '../src/reviewApp.js';

test('renders a self-contained MCP App review panel', () => {
	const html = renderTransmissionReviewApp();
	assert.equal(MCP_APP_MIME_TYPE, 'text/html;profile=mcp-app');
	assert.match(REVIEW_APP_URI, /^ui:\/\//);
	assert.match(html, /Codex 尚不可见/);
	assert.match(html, /确认并发送给 Codex/);
	assert.match(html, /ui\/notifications\/tool-result/);
	assert.match(html, /tools\/call/);
	assert.match(html, /get_review_draft_for_ui/);
	assert.match(html, /submit_review_decision_for_ui/);
	assert.doesNotMatch(html, /https?:\/\//);
});
