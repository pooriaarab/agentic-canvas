import { readFileSync } from 'node:fs';

for (const name of ['agentic-design', 'agentic-identity', 'agentic-realtime']) {
  const readVersion = (packageName) => JSON.parse(
    readFileSync(new URL(`../node_modules/${packageName}/package.json`, import.meta.url), 'utf8'),
  ).version;
  const actual = readVersion(name);
  const pinned = readVersion(`${name}-current`);
  if (actual !== pinned) {
    throw new Error(`${name}: tested version ${actual} differs from development pin ${pinned}`);
  }
  console.log(`${name}: ${actual}`);
}
