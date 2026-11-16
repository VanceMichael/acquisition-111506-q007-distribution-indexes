
import { readFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
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
    // noByHash：模拟 by-hash 暂时不可用；mutatedIndex：模拟发布进行中，
    // 不受哈希固定的可变路径已换成发行描述之外的字节。
    if (!options.noByHash && url.pathname.endsWith('/by-hash/SHA256/' + hash(gzip))) return bytes(response, gzip, 'application/octet-stream', 200, { etag: '"index-v11"' });
    if (url.pathname.endsWith('/Packages.gz')) {
      if (options.mutatedIndex) {
        state.mutated ??= gzipSync(gunzipSync(gzip).toString('utf8')
          + '\nPackage: rogue\nVersion: 9.9\nArchitecture: amd64\nFilename: pool/r/rogue_9.9_amd64.deb\nSize: 1\nSHA256: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\nDescription: injected mid-publish\n');
        return bytes(response, state.mutated, 'application/octet-stream', 200, { etag: '"mutable-v12"' });
      }
      return bytes(response, gzip, 'application/octet-stream', 200, { etag: '"mutable-latest"' });
    }
    if (url.pathname.includes('/Packages.xz')) return json(response, { error: 'representation_unavailable' }, 404);
    return false;
  }, options);
}
