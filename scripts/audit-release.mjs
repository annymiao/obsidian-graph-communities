import { readFile } from 'node:fs/promises';

const releaseFiles = ['main.js', 'manifest.json', 'styles.css'];
const contents = new Map(await Promise.all(
  releaseFiles.map(async (filename) => [filename, await readFile(filename, 'utf8')])
));
const manifest = JSON.parse(contents.get('manifest.json'));
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

if (manifest.version !== packageJson.version) {
  throw new Error(`Version mismatch: manifest=${manifest.version}, package=${packageJson.version}`);
}

const forbidden = [
  ['/', 'Users', '/'].join(''),
  ['/', 'home', '/'].join(''),
  ['C:', '\\', 'Users', '\\'].join(''),
  ['BEGIN ', 'PRIVATE KEY'].join(''),
  ['github', '_pat_'].join(''),
  ['gh', 'p_'].join(''),
  ['gh', 'o_'].join(''),
];
for (const [filename, content] of contents) {
  for (const marker of forbidden) {
    if (content.includes(marker)) throw new Error(`${filename} contains forbidden marker: ${marker}`);
  }
}

const runtime = contents.get('main.js');
for (const networkApi of ['fetch(', 'XMLHttpRequest', 'WebSocket(', 'EventSource(']) {
  if (runtime.includes(networkApi)) {
    throw new Error(`main.js unexpectedly references network API: ${networkApi}`);
  }
}

console.log(
  `Release audit passed: ${releaseFiles.join(', ')} · version ${manifest.version} · no local paths, credential markers, or network APIs.`
);
