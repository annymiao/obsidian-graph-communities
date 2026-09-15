import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const arguments_ = process.argv.slice(2);
let nodeExecutable;
let serverPath;
let sourceEnvironmentName;
let sourceEnvironmentValue;
let reviewMode = 'required';
if (arguments_.length === 3) {
	[nodeExecutable, serverPath, sourceEnvironmentValue] = arguments_;
	sourceEnvironmentName = 'OBSIDIAN_VAULT_PATH';
} else {
	[
		nodeExecutable,
		serverPath,
		sourceEnvironmentName,
		sourceEnvironmentValue,
		reviewMode,
	] = arguments_;
}
if (
	!nodeExecutable
	|| !serverPath
	|| !sourceEnvironmentValue
	|| !['OBSIDIAN_VAULT_PATH', 'OBSIDIAN_SOURCES_JSON'].includes(sourceEnvironmentName)
	|| !['required', 'trusted-local', 'disabled'].includes(reviewMode)
) {
	process.stderr.write(
		'usage: smoke-client.mjs NODE SERVER VAULT\n'
		+ '   or: smoke-client.mjs NODE SERVER SOURCE_ENV SOURCE_VALUE REVIEW_MODE\n',
	);
	process.exit(2);
}

const childEnvironment = { ...process.env };
delete childEnvironment.OBSIDIAN_VAULT_PATH;
delete childEnvironment.OBSIDIAN_SOURCES_JSON;
childEnvironment[sourceEnvironmentName] = sourceEnvironmentValue;
childEnvironment.OBSIDIAN_TRANSMISSION_REVIEW = reviewMode;

const transport = new StdioClientTransport({
	command: nodeExecutable,
	args: [serverPath],
	env: childEnvironment,
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
	const parsedOverview = JSON.parse(text);
	process.stdout.write(`${JSON.stringify({
		tools: tools.tools.map((tool) => tool.name).sort(),
		overview: {
			kind: parsedOverview.kind ?? 'single',
			source_count: parsedOverview.sourceCount ?? 1,
			available_source_count: parsedOverview.availableSourceCount ?? 1,
			indexed_note_count: parsedOverview.indexedNoteCount,
			index_origin: parsedOverview.indexOrigin,
			persistence_status: parsedOverview.persistenceStatus,
		},
	}, null, 2)}\n`);
} finally {
	await client.close();
}
