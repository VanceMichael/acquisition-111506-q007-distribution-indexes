import test from 'node:test';
import assert from 'node:assert/strict';
import { startProvider } from '../provider/source.mjs';

test("来源实际交互保持已声明的语义", async () => {
  const source = await startProvider();
  try {
    const releaseResponse = await fetch(`${source.url}/repos/demo/InRelease`);
    assert.equal(releaseResponse.headers.get('etag'), '"release-v11"');
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const gzip = Buffer.from((await readFile(new URL('../fixtures/index.gz.b64', import.meta.url), 'utf8')).trim(), 'base64');
    const digest = createHash('sha256').update(gzip).digest('hex');
    const indexResponse = await fetch(`${source.url}/repos/demo/by-hash/SHA256/${digest}`);
    assert.equal(indexResponse.status, 200);
    assert.ok((await indexResponse.arrayBuffer()).byteLength > 0);
    assert.equal((await fetch(`${source.url}/dists/demo/main/binary-amd64/Packages.xz`)).status, 404);
  } finally { await source.close(); }
});
