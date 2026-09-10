import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function createFixtureVault(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), 'obsidian-knowledge-mcp-test-'));
	await writeNote(root, '30-Shared-Knowledge/Codex 写作系统.md', [
		'---',
		'title: Codex 写作系统',
		'aliases: [关系写作, Personal writing agent]',
		'tags: [codex, writing]',
		'type: knowledge-card',
		'status: active',
		'retrieval_scope: default',
		'---',
		'',
		'# Codex 写作系统',
		'',
		'目标是让 Codex 在分析前自动获得个人知识背景。',
		'',
		'## 决策',
		'',
		'使用 [[MCP 方案]] 提供只读知识工具。',
	].join('\n'));
	await writeNote(root, '30-Shared-Knowledge/MCP 方案.md', [
		'---',
		'title: 上下文协议设计',
		'tags:',
		'  - codex',
		'  - obsidian',
		'type: knowledge-card',
		'status: active',
		'retrieval_scope: default',
		'---',
		'',
		'# 上下文协议设计',
		'',
		'Model Context Protocol connects Codex to personal notes through read-only tools.',
		'它继续连接到 [[关系索引算法]]。',
	].join('\n'));
	await writeNote(root, '30-Shared-Knowledge/关系索引算法.md', [
		'---',
		'type: knowledge-card',
		'status: active',
		'retrieval_scope: default',
		'---',
		'',
		'# 关系索引算法',
		'',
		'使用双向链接、两跳路径、共享标签和共同引用扩展候选资料。',
	].join('\n'));
	await writeNote(root, 'Unrelated/购物清单.md', '# 购物清单\n\n- 牛奶\n');
	await writeNote(root, '.obsidian/private.md', '# 不应读取\n\nsecret\n');
	return root;
}

export async function removeFixtureVault(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

async function writeNote(root: string, relativePath: string, content: string): Promise<void> {
	const absolutePath = path.join(root, relativePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, 'utf8');
}
