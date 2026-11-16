import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { parseRelease, parsePackages } from '../src/deb822.mjs';
import { validateRelease, planTargets, representationOf } from '../src/collect.mjs';
import { digest } from '../src/store.mjs';

const releaseText = await readFile(new URL('../fixtures/release.txt', import.meta.url), 'utf8');
const gzip = Buffer.from((await readFile(new URL('../fixtures/index.gz.b64', import.meta.url), 'utf8')).trim(), 'base64');
const gzipSha = digest(gzip);
const releaseSha = digest(Buffer.from(releaseText, 'utf8'));

async function withApp(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const application = await startApplication({ directory });
  try {
    return await fn(application);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function collect(application, source, text, extra = {}) {
  const response = await fetch(`${application.url}/api/collect`, {
    method: 'POST',
    body: JSON.stringify({
      release: { source: 'approval:ops-2026-11-16', bytesBase64: Buffer.from(text, 'utf8').toString('base64') },
      indexBase: `${source.url}/dists/demo`,
      ...extra,
    }),
  });
  return { status: response.status, body: await response.json() };
}

const recordsOf = async application => (await (await fetch(`${application.url}/api/records`)).json());
const historyOf = async (application, key) => (await (await fetch(`${application.url}/api/history?key=${encodeURIComponent(key)}`)).json());

test('发行描述与包索引的Deb822解析', () => {
  const release = parseRelease(releaseText);
  assert.equal(release.suite, 'stable');
  assert.equal(release.codename, 'bookworm');
  assert.deepEqual(release.architectures, ['amd64', 'arm64', 'all']);
  assert.deepEqual(release.components, ['main']);
  assert.equal(release.validUntil, null);
  assert.deepEqual(release.indexes, [
    { sha256: gzipSha, size: 212, path: 'main/binary-amd64/Packages.gz' },
    { sha256: gzipSha, size: 212, path: 'main/binary-arm64/Packages.gz' },
  ]);
  const paragraphs = parsePackages(gunzipSync(gzip).toString('utf8'));
  assert.equal(paragraphs.length, 4);
  const alpha = paragraphs[0];
  assert.equal(alpha.fields.Package, 'alpha');
  assert.equal(alpha.fields.Description, 'sample alpha\n multiline text');
  assert.ok(alpha.raw.startsWith('Package: alpha'));
  assert.equal(representationOf('main/binary-amd64/Packages.gz'), 'gzip');
  assert.equal(representationOf('main/binary-amd64/Packages.xz'), 'xz');
  assert.equal(representationOf('main/binary-amd64/Packages'), 'plain');
});

test('过期发行被拒绝，未过期与无Valid-Until可继续', () => {
  const expired = parseRelease(releaseText + 'Valid-Until: Sun, 15 Nov 2020 00:00:00 UTC\n');
  assert.throws(() => validateRelease(expired, new Date('2026-11-16T00:00:00Z')), /已过期/);
  const fresh = parseRelease(releaseText + 'Valid-Until: Tue, 16 Nov 2027 00:00:00 UTC\n');
  assert.doesNotThrow(() => validateRelease(fresh, new Date('2026-11-16T00:00:00Z')));
  assert.doesNotThrow(() => validateRelease(parseRelease(releaseText)));
  const targets = planTargets(parseRelease(releaseText));
  assert.deepEqual(targets.map(target => `${target.component}/${target.architecture}`), ['main/amd64', 'main/arm64']);
});

test('端到端：核准发行描述出发采集两个架构，记录可回查且幂等', async () => {
  const source = await startProvider();
  try {
    await withApp(async application => {
      // 调用方在既有审批边界内获取并验签发行描述，服务本身不取Release。
      const approvedText = await (await fetch(`${source.url}/repos/demo/InRelease`)).text();
      const beforeCollect = source.events.length;
      const first = await collect(application, source, approvedText);
      assert.equal(first.status, 201);
      assert.equal(first.body.packageCount, 4);
      assert.deepEqual(first.body.targets.map(target => target.fetchedVia), ['by-hash', 'by-hash']);
      assert.deepEqual(first.body.targets.map(target => target.architecture), ['amd64', 'arm64']);

      // 采集之后服务没有自行获取发行描述、签名材料或软件包。
      const serviceFetches = source.events.slice(beforeCollect).map(event => event.path);
      assert.ok(serviceFetches.every(path => path.includes('/by-hash/')));
      assert.ok(serviceFetches.every(path => !path.includes('/pool/') && !path.includes('.gpg') && !path.includes('InRelease')));

      const records = await recordsOf(application);
      assert.equal(records.length, 5);
      const byKey = new Map(records.map(receipt => [receipt.key, receipt.record]));

      // 同名多版本、同版本多架构并存，不按包名去重。
      for (const key of ['auto:main:alpha:1.0:amd64', 'auto:main:alpha:2.0:amd64', 'auto:main:alpha:1.0:arm64']) {
        assert.ok(byKey.has(key), `缺少记录 ${key}`);
      }
      // Architecture: all 只有一条记录，适用关系记在 appliesTo。
      const shared = byKey.get('auto:main:shared:2.0:all');
      assert.equal(shared.architecture, 'all');
      assert.deepEqual(shared.appliesTo, ['amd64', 'arm64']);
      assert.deepEqual(shared.sourcePaths, ['main/binary-amd64/Packages.gz', 'main/binary-arm64/Packages.gz']);
      assert.ok(shared.raw.includes('Package: shared'));

      // 每条包记录绑定发行描述、组件、架构，原字段保留。
      const alpha = byKey.get('auto:main:alpha:1.0:amd64');
      assert.equal(alpha.component, 'main');
      assert.equal(alpha.release.suite, 'stable');
      assert.equal(alpha.release.codename, 'bookworm');
      assert.equal(alpha.release.sha256, releaseSha);
      assert.equal(alpha.filename, 'pool/a/alpha_1.0_amd64.deb');
      assert.equal(alpha.size, 120);
      assert.equal(alpha.sha256, 'a'.repeat(64));
      assert.equal(alpha.description, 'sample alpha\n multiline text');

      // 采集完整性记录。
      const collection = byKey.get(`collection:${releaseSha}`);
      assert.equal(collection.kind, 'collection');
      assert.equal(collection.packageCount, 4);
      assert.equal(collection.release.validUntil, null);

      // 原始依据回查：发行描述原文与索引原始字节（与发行声明的摘要一致）。
      const releaseEvidence = await (await fetch(`${application.url}/api/evidence/${releaseSha}`)).text();
      assert.equal(releaseEvidence, approvedText);
      const indexEvidence = Buffer.from(await (await fetch(`${application.url}/api/evidence/${gzipSha}`)).arrayBuffer());
      assert.ok(indexEvidence.equals(gzip));

      // 相同发行重复采集：全部幂等，不产生新版本。
      const again = await collect(application, source, approvedText);
      assert.equal(again.status, 200);
      assert.ok(again.body.packages.every(item => item.duplicate));
      assert.equal((await recordsOf(application)).length, 5);
      assert.equal((await historyOf(application, 'auto:main:shared:2.0:all')).length, 1);
    });
  } finally { await source.close(); }
});

test('发行更新形成历史版本，旧记录不被覆盖丢失', async () => {
  const source = await startProvider();
  try {
    await withApp(async application => {
      await collect(application, source, releaseText);
      const nextRelease = releaseText.replace('15 Nov 2026 10:00:00', '16 Nov 2026 10:00:00');
      const second = await collect(application, source, nextRelease);
      assert.equal(second.status, 201);
      const history = await historyOf(application, 'auto:main:alpha:1.0:amd64');
      assert.equal(history.length, 2);
      assert.equal(history[0].record.release.date, 'Sun, 15 Nov 2026 10:00:00 UTC');
      assert.equal(history[1].record.release.date, 'Sun, 16 Nov 2026 10:00:00 UTC');
      const records = await recordsOf(application);
      assert.equal(records.filter(receipt => receipt.record.kind === 'collection').length, 2);
    });
  } finally { await source.close(); }
});

test('过期发行不进入正式结果，也不触发索引下载', async () => {
  const source = await startProvider();
  try {
    await withApp(async application => {
      const expired = releaseText + 'Valid-Until: Sun, 15 Nov 2020 00:00:00 UTC\n';
      const outcome = await collect(application, source, expired);
      assert.equal(outcome.status, 422);
      assert.match(outcome.body.error, /已过期/);
      assert.equal((await recordsOf(application)).length, 0);
      assert.equal(source.events.filter(event => event.path.includes('Packages')).length, 0);
    });
  } finally { await source.close(); }
});

test('发行声明被篡改时校验失败，成功的架构也不混入正式结果', async () => {
  const source = await startProvider();
  try {
    await withApp(async application => {
      const tampered = releaseText.replace(
        `${gzipSha} 212 main/binary-arm64/Packages.gz`,
        `${'0'.repeat(64)} 212 main/binary-arm64/Packages.gz`,
      );
      const outcome = await collect(application, source, tampered);
      assert.equal(outcome.status, 502);
      assert.match(outcome.body.error, /binary-arm64/);
      // amd64 索引已成功取回，但发行整体校验失败，半个发行不得入库。
      assert.ok(source.events.some(event => event.path.includes('binary-amd64')));
      assert.equal((await recordsOf(application)).length, 0);
    });
  } finally { await source.close(); }
});

test('by-hash暂时不可用时回退普通路径，仍按发行声明验证字节', async () => {
  const source = await startProvider({ noByHash: true });
  try {
    await withApp(async application => {
      const outcome = await collect(application, source, releaseText);
      assert.equal(outcome.status, 201);
      assert.deepEqual(outcome.body.targets.map(target => target.fetchedVia), ['path', 'path']);
      assert.ok(outcome.body.targets.every(target => target.url.endsWith('/Packages.gz') && target.sha256 === gzipSha));
      const indexEvidence = Buffer.from(await (await fetch(`${application.url}/api/evidence/${gzipSha}`)).arrayBuffer());
      assert.ok(indexEvidence.equals(gzip));
    });
  } finally { await source.close(); }
});

test('发布进行中的可变路径不能替代发行声明的字节', async () => {
  // by-hash 可用：可变路径已被新版本改写也不影响一致性快照。
  const pinned = await startProvider({ mutatedIndex: true });
  try {
    await withApp(async application => {
      const outcome = await collect(application, pinned, releaseText);
      assert.equal(outcome.status, 201);
      assert.deepEqual(outcome.body.targets.map(target => target.fetchedVia), ['by-hash', 'by-hash']);
    });
  } finally { await pinned.close(); }
  // by-hash 不可用且可变路径已改写：与发行声明不符，整个发行被拒绝。
  const moved = await startProvider({ mutatedIndex: true, noByHash: true });
  try {
    await withApp(async application => {
      const outcome = await collect(application, moved, releaseText);
      assert.equal(outcome.status, 502);
      assert.match(outcome.body.error, /发行声明不符/);
      assert.equal((await recordsOf(application)).length, 0);
    });
  } finally { await moved.close(); }
});

test('发行只声明不支持的压缩表示时明确失败', async () => {
  const source = await startProvider();
  try {
    await withApp(async application => {
      const xzOnly = releaseText.replaceAll('Packages.gz', 'Packages.xz');
      const outcome = await collect(application, source, xzOnly);
      assert.equal(outcome.status, 502);
      assert.match(outcome.body.error, /不支持/);
      assert.equal((await recordsOf(application)).length, 0);
    });
  } finally { await source.close(); }
});

test('核准摘要与发行描述不符时拒绝采集', async () => {
  const source = await startProvider();
  try {
    await withApp(async application => {
      const response = await fetch(`${application.url}/api/collect`, {
        method: 'POST',
        body: JSON.stringify({
          release: { source: 'approval:ops', bytesBase64: Buffer.from(releaseText, 'utf8').toString('base64'), sha256: 'f'.repeat(64) },
          indexBase: `${source.url}/dists/demo`,
        }),
      });
      assert.equal(response.status, 422);
      assert.match((await response.json()).error, /核准摘要/);
      assert.equal((await recordsOf(application)).length, 0);
    });
  } finally { await source.close(); }
});
