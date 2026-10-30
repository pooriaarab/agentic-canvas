import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve('.');
const host = mkdtempSync(join(tmpdir(), 'canvas-packed-host-'));
try {
  const tarball = execFileSync('npm', ['pack', '--pack-destination', host, '--silent'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(host, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(host, tarball), 'agentic-identity@0.12.0', 'typescript@5.6.3'], { cwd: host, stdio: 'inherit' });
  writeFileSync(join(host, 'host.mts'), `import { createAccountRegistry } from "agentic-identity/account";
import { canvasAccount, type CanvasAccountDeps } from "agentic-canvas/account";
declare const deps: CanvasAccountDeps;
createAccountRegistry().register(canvasAccount, deps);
`);
  execFileSync(process.execPath, [join(host, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'host.mts'], { cwd: host, stdio: 'inherit' });
  writeFileSync(join(host, 'host.mjs'), `import { createAccountRegistry } from "agentic-identity/account";
import { canvasAccount } from "agentic-canvas/account";
import assert from "node:assert/strict";
assert.deepEqual(createAccountRegistry().register(canvasAccount, {}).ids(), ["canvas"]);
`);
  execFileSync(process.execPath, ['host.mjs'], { cwd: host, stdio: 'inherit' });
  console.log('Packed account host compiles and loads with identity 0.12.0');
} finally {
  rmSync(host, { recursive: true, force: true });
}
