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
	assert.match(html, /assertToolSucceeded\(result\)/);
	assert.match(html, /editable = draft\.editable !== false/);
	assert.match(html, /reviewKind = draft\.review_kind === 'controlled-write'/);
	assert.match(html, /content\.readOnly = !editable/);
	assert.match(html, /本审核不可编辑/);
	assert.match(html, /取消，不执行操作/);
	assert.match(html, /未执行写入或撤销/);
	assert.match(html, /可修改或删除任意内容/);
	assert.doesNotMatch(html, /https?:\/\//);
});
