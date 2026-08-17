const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const backendRoot = path.resolve(__dirname, '../..');

function collectJs(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJs(full, output);
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push(full);
  }
  return output;
}

test('GOLDEN backend: todos os JS de producao passam node --check', () => {
  const files = [
    path.join(backendRoot, 'server.js'),
    ...collectJs(path.join(backendRoot, 'src')),
  ];

  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push(`${path.relative(backendRoot, file)}: ${result.stderr || result.stdout}`);
    }
  }

  assert.deepEqual(failures, []);
  assert.ok(files.length >= 60, `esperados >= 60 JS de producao; encontrados ${files.length}`);
});
