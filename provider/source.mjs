
import { readFile } from 'node:fs/promises';
import { serve, json, bytes, hash } from './http.mjs';
const gzip = Buffer.from((await readFile(new URL('../fixtures/index.gz.b64', import.meta.url), 'utf8')).trim(), 'base64');
const release = await readFile(new URL('../fixtures/release.txt', import.meta.url), 'utf8');
const indices = JSON.parse(await readFile(new URL('../fixtures/indices.json', import.meta.url), 'utf8'));
export async function startProvider(options = {}) {
  return serve(async ({ request, response, url, state }) => {
    if (url.pathname === '/repos/demo/InRelease') {
      const stale = options.scenario === 'changed' && state.releaseRead > 0;
      state.releaseRead = (state.releaseRead ?? 0) + 1;
      const body = stale ? release.replace('stable', 'oldstable') : release;
      return bytes(response, body, 'text/plain', 200, { etag: stale ? '"release-old"' : '"release-v11"' });
    }
    if (url.pathname.endsWith('/by-hash/SHA256/' + hash(gzip))) return bytes(response, gzip, 'application/octet-stream', 200, { etag: '"index-v11"' });
    if (url.pathname.endsWith('/Packages.gz')) return bytes(response, gzip, 'application/octet-stream', 200, { etag: '"mutable-latest"' });
    if (url.pathname.includes('/Packages.xz')) return json(response, { error: 'representation_unavailable' }, 404);
    return false;
  }, options);
}
