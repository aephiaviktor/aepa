import { readFile } from 'node:fs/promises';

const packageName = '@aephia/atlas-kit';
const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const [project, lock, installed, registryResponse] = await Promise.all([
  readJson(new URL('../package.json', import.meta.url)),
  readJson(new URL('../package-lock.json', import.meta.url)),
  readJson(new URL('../node_modules/@aephia/atlas-kit/package.json', import.meta.url)),
  fetch(registryUrl, { headers: { accept: 'application/vnd.npm.install-v1+json' } }),
]);

if (!registryResponse.ok) {
  throw new Error(`Could not read ${packageName} dist-tags: HTTP ${registryResponse.status}`);
}

const registry = await registryResponse.json();
const expected = registry['dist-tags']?.next;
const declared = project.dependencies?.[packageName];
const locked = lock.packages?.[`node_modules/${packageName}`]?.version;
const installedVersion = installed.version;

if (!expected) throw new Error(`${packageName} has no next dist-tag`);
if (declared !== 'next') throw new Error(`${packageName} must be declared as "next"; found ${JSON.stringify(declared)}`);
if (locked !== expected || installedVersion !== expected) {
  throw new Error(
    `${packageName} is stale: next=${expected}, lock=${locked ?? 'missing'}, installed=${installedVersion ?? 'missing'}. ` +
    'Run npm run atlas-kit:update.',
  );
}

console.log(`${packageName} is current on next (${expected}).`);
