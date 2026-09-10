export const REVIEW_APP_URI = 'ui://obsidian-knowledge/transmission-review-v1.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export function renderTransmissionReviewApp(): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Obsidian → Codex 传输审核</title>
	<style>
		:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		* { box-sizing: border-box; }
		body { min-height: 100vh; margin: 0; background: Canvas; color: CanvasText; }
		main { display: flex; min-height: 100vh; flex-direction: column; gap: 14px; padding: 18px; }
		header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
		h1 { margin: 0 0 7px; font-size: 20px; line-height: 1.25; }
		p { margin: 0; color: GrayText; font-size: 13px; line-height: 1.5; }
		.badge { flex: none; border: 1px solid #d79922; border-radius: 999px; padding: 5px 9px; color: #a16b00; font-size: 12px; font-weight: 700; }
		.badge.approved { border-color: #2b9960; color: #187548; }
		.badge.cancelled { border-color: #888; color: GrayText; }
		.meta { color: GrayText; font-size: 12px; }
		textarea { width: 100%; min-height: 360px; flex: 1; resize: vertical; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 10px; padding: 13px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); color: CanvasText; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
		textarea:focus { outline: 2px solid #7c5cff; outline-offset: 1px; }
		.notice { border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 10px; padding: 12px; color: GrayText; font-size: 13px; line-height: 1.5; }
		.notice.error { border-color: #bb4444; color: #b33333; }
		.actions { display: flex; justify-content: flex-end; gap: 9px; }
		button { border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: 9px; padding: 9px 13px; background: transparent; color: CanvasText; cursor: pointer; font-weight: 650; }
		button.primary { border-color: #6f4cff; background: #6f4cff; color: white; }
		button:disabled { cursor: default; opacity: .5; }
		[hidden] { display: none !important; }
	</style>
</head>
<body>
	<main>
		<header>
			<div><h1 id="title">Obsidian → Codex 传输审核</h1><p id="description">正在安全载入待审核内容…</p></div>
			<span class="badge" id="badge">Codex 尚不可见</span>
		</header>
		<div class="meta" id="meta">原文仅存在于本地审核服务与此组件的私有数据中。</div>
		<div class="notice" id="loading">正在打开右侧审核面板…</div>
		<textarea id="content" aria-label="将发送给 Codex 的 Obsidian 信息" hidden></textarea>
		<div class="notice error" id="error" role="alert" hidden></div>
		<div class="actions" id="actions" hidden>
			<button id="cancel" type="button">取消，不发送</button>
			<button class="primary" id="approve" type="button">确认并发送给 Codex</button>
		</div>
	</main>
	<script>
		(function () {
			'use strict';
			var requestId = 0;
			var pending = new Map();
			var credentials = null;
			var loaded = false;
			var title = document.getElementById('title');
			var description = document.getElementById('description');
			var badge = document.getElementById('badge');
			var metaLine = document.getElementById('meta');
			var loading = document.getElementById('loading');
			var content = document.getElementById('content');
			var errorBox = document.getElementById('error');
			var actions = document.getElementById('actions');
			var approve = document.getElementById('approve');
			var cancel = document.getElementById('cancel');

			window.addEventListener('message', function (event) {
				if (event.source !== window.parent) return;
				var message = event.data;
				if (!message || message.jsonrpc !== '2.0') return;
				if (message.id !== undefined && pending.has(message.id)) {
					var handler = pending.get(message.id);
					pending.delete(message.id);
					if (message.error) handler.reject(new Error(message.error.message || '组件工具调用失败'));
					else handler.resolve(message.result);
					return;
				}
				if (message.method === 'ui/notifications/tool-result') {
					void acceptInitialEnvelope(message.params);
				}
			});

			function bridgeRequest(method, params) {
				return new Promise(function (resolve, reject) {
					var id = ++requestId;
					pending.set(id, { resolve: resolve, reject: reject });
					window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*');
				});
			}

			function callTool(name, args) {
				if (window.openai && typeof window.openai.callTool === 'function') {
					return window.openai.callTool(name, args);
				}
				return bridgeRequest('tools/call', { name: name, arguments: args });
			}

			function findNamedObject(value, key, depth, seen) {
				if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return null;
				seen.add(value);
				if (value[key] && typeof value[key] === 'object') return value[key];
				var entries = Array.isArray(value) ? value : Object.values(value);
				for (var i = 0; i < entries.length; i += 1) {
					var found = findNamedObject(entries[i], key, depth + 1, seen);
					if (found) return found;
				}
				return null;
			}

			async function acceptInitialEnvelope(envelope) {
				if (loaded) return;
				var auth = findNamedObject(envelope, 'obsidianReview', 0, new Set());
				if (!auth || typeof auth.review_id !== 'string' || typeof auth.ui_token !== 'string') return;
				loaded = true;
				credentials = auth;
				try {
					var result = await callTool('get_review_draft_for_ui', {
						review_id: auth.review_id,
						ui_token: auth.ui_token
					});
					var draft = findNamedObject(result, 'obsidianReviewDraft', 0, new Set());
					if (!draft || typeof draft.content !== 'string') throw new Error('审核组件没有收到私有草稿。');
					renderDraft(draft);
				} catch (error) {
					showError(error);
				}
			}

			function renderDraft(draft) {
				title.textContent = draft.title || 'Obsidian → Codex 传输审核';
				description.textContent = draft.description || '请审核后再发送。';
				content.value = draft.content;
				loading.hidden = true;
				content.hidden = false;
				actions.hidden = false;
				updateCount();
				content.addEventListener('input', updateCount);
				content.focus();
			}

			function updateCount() {
				metaLine.textContent = content.value.length.toLocaleString('zh-CN') + ' 个字符 · 可修改或删除任意内容 · 确认前 Codex 模型不可见';
			}

			function setBusy(isBusy) {
				approve.disabled = isBusy;
				cancel.disabled = isBusy;
				content.disabled = isBusy;
			}

			async function decide(action) {
				if (!credentials) return;
				if (action === 'approve' && !content.value.trim()) {
					showError(new Error('内容不能为空；可以选择“取消，不发送”。'));
					return;
				}
				setBusy(true);
				errorBox.hidden = true;
				try {
					await callTool('submit_review_decision_for_ui', {
						review_id: credentials.review_id,
						ui_token: credentials.ui_token,
						action: action,
						content: action === 'approve' ? content.value : undefined
					});
					content.hidden = true;
					actions.hidden = true;
					loading.hidden = false;
					badge.className = 'badge ' + (action === 'approve' ? 'approved' : 'cancelled');
					badge.textContent = action === 'approve' ? '已确认发送' : '已取消';
					loading.textContent = action === 'approve'
						? '审核后的内容已获授权，Codex 现在可以领取。'
						: '本次没有向 Codex 发送任何 Obsidian 正文。';
					metaLine.textContent = action === 'approve' ? '授权已完成。' : '私有草稿已清除。';
				} catch (error) {
					setBusy(false);
					showError(error);
				}
			}

			function showError(error) {
				loading.hidden = true;
				errorBox.hidden = false;
				errorBox.textContent = error instanceof Error ? error.message : String(error);
			}

			approve.addEventListener('click', function () { void decide('approve'); });
			cancel.addEventListener('click', function () { void decide('cancel'); });

			var attempts = 0;
			var compatibilityTimer = setInterval(function () {
				attempts += 1;
				if (loaded || attempts > 80) {
					clearInterval(compatibilityTimer);
					if (!loaded) showError(new Error('没有收到审核授权。请在 Codex 中重新发起 Obsidian 查询。'));
					return;
				}
				if (window.openai && window.openai.toolResponseMetadata) {
					void acceptInitialEnvelope(window.openai.toolResponseMetadata);
				}
			}, 100);
		})();
	</script>
</body>
</html>`;
}
