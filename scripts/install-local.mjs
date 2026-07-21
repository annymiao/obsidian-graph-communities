import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vaultPath = process.argv[2];
const shouldEnable = process.argv.includes('--enable');
const pluginId = 'graph-communities';

if (!vaultPath) {
  console.error('Usage: node scripts/install-local.mjs /path/to/vault [--enable]');
  process.exit(2);
}

const obsidianDirectory = path.join(vaultPath, '.obsidian');
await access(obsidianDirectory);
const destination = path.join(obsidianDirectory, 'plugins', pluginId);
await mkdir(destination, { recursive: true });

for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
  await copyFile(path.join(root, filename), path.join(destination, filename));
}

if (shouldEnable) {
  const enabledPath = path.join(obsidianDirectory, 'community-plugins.json');
  let enabled = [];
  try {
    enabled = JSON.parse(await readFile(enabledPath, 'utf8'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  if (!Array.isArray(enabled)) {
    throw new Error(`${enabledPath} must contain a JSON array`);
  }
  if (!enabled.includes(pluginId)) {
    enabled.push(pluginId);
    enabled.sort();
    await writeFile(enabledPath, `${JSON.stringify(enabled, null, 2)}\n`, 'utf8');
  }
}

console.log(`Installed ${pluginId} in ${destination}${shouldEnable ? ' and enabled it' : ''}.`);
