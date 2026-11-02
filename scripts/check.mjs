import { readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['server.js'];
for (const directory of ['public', 'scripts']) {
  files.push(...readdirSync(join(root, directory), { recursive: true })
    .filter(file => /\.(js|mjs)$/.test(file))
    .map(file => join(directory, file)));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0 || result.error) process.exit(result.status || 1);
}
console.log(`语法检查通过：${files.length} 个 JavaScript 文件。`);
