import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
if (!scripts.length) {
  console.error('No script blocks found in public/index.html.');
  process.exit(1);
}
for (let i = 0; i < scripts.length; i++) {
  const result = spawnSync(process.execPath, ['--check', '-'], {
    input: scripts[i][1],
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(`Inline script ${i + 1} has a syntax error:`);
    process.stderr.write(result.stderr || result.stdout || 'Node did not return details.');
    process.exit(result.status || 1);
  }
}
console.log(`Checked ${scripts.length} inline script block(s).`);
