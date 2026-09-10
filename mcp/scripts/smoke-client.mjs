import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [nodeExecutable, serverPath, vaultPath] = process.argv.slice(2);
if (!nodeExecutable || !serverPath || !vaultPath) {
	process.stderr.write('usage: smoke-client.mjs NODE SERVER VAULT\n');
	process.exit(2);
}

const transport = new StdioClientTransport({
	command: nodeExecutable,
	args: [serverPath],
	env: {
		...process.env,
		OBSIDIAN_VAULT_PATH: vaultPath,
	},
});
const client = new Client({ name: 'obsidian-knowledge-smoke', version: '0.1.0' });

try {
	await client.connect(transport);
	const tools = await client.listTools();
	const overview = await client.callTool({
		name: 'get_vault_overview',
		arguments: { refresh: true },
	});
	const content = Array.isArray(overview.content) ? overview.content : [];
	const first = content[0];
	const text = first && typeof first === 'object' && first.type === 'text'
		&& typeof first.text === 'string'
		? first.text
		: '{}';
	process.stdout.write(`${JSON.stringify({
		tools: tools.tools.map((tool) => tool.name).sort(),
		overview: JSON.parse(text),
	}, null, 2)}\n`);
} finally {
	await client.close();
}
