import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
// Share the static Worker's reviewed allowlist. Never copy repository directories.
const allowlist = (await readFile(path.join(root, '.assetsignore'), 'utf8'))
  .split('\n').filter(line => line.startsWith('!/'))
  .map(line => new RegExp('^' + line.slice(2).split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
if (!allowlist.length) throw new Error('Public asset allowlist is empty.');
await rm(output, { recursive: true, force: true });
await mkdir(output);
let count = 0;
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (!['_headers', '_redirects'].includes(entry.name) && !allowlist.some(rule => rule.test(entry.name))) continue;
  await copyFile(path.join(root, entry.name), path.join(output, entry.name));
  count++;
}
// A top-level 404 disables Pages' default SPA fallback for nonexistent paths.
await writeFile(path.join(output, '404.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — VeoClara</title><h1>Page not found</h1><p><a href="/">Return to VeoClara</a></p></html>\n');
console.log(`Prepared ${count + 1} public website files in dist/.`);
