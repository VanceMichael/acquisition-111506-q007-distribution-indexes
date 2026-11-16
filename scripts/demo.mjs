
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { product } from '../src/domain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const source = await startProvider();
const application = await startApplication({ directory });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const post = async (path, body) => {
  const response = await fetch(`${application.url}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
try {
  const fixture = await readFile(new URL('../fixtures/manual.json', import.meta.url));
  const record = JSON.parse(fixture);
  console.log(`${product}：人工收件与原始依据回查`);
  console.log('本地来源状态', await (await fetch(`${source.url}/health`)).text());
  const body = { record, evidence: [{ source: 'operator:local', bytesBase64: fixture.toString('base64'), mediaType: 'application/json' }] };
  for (const label of ['首次提交', '同件再次提交']) {
    const response = await fetch(`${application.url}/api/manual`, { method: 'POST', body: JSON.stringify(body) });
    const receipt = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(receipt));
    console.log(label, JSON.stringify({ status: response.status, key: receipt.key, duplicate: receipt.duplicate, identity: receipt.identity }));
    const evidence = await (await fetch(`${application.url}/api/evidence/${receipt.evidence[0].sha256}`)).arrayBuffer();
    if (!Buffer.from(evidence).equals(fixture)) throw new Error('原始依据不一致');
  }

  console.log('\n自动采集：从已核准的发行描述出发（调用方在既有审批边界内验签，服务不接触密钥）');
  // 调用方获取并核准发行描述；采集服务只接收核准后的字节与核准来源标识。
  const approvedRelease = await (await fetch(`${source.url}/repos/demo/InRelease`)).text();
  const collect = async (text, base = source.url) => post('/api/collect', {
    release: { source: 'approval:ops-2026-11-16', bytesBase64: Buffer.from(text, 'utf8').toString('base64') },
    indexBase: `${base}/dists/demo`,
  });
  const first = await collect(approvedRelease);
  if (first.status !== 201) throw new Error(JSON.stringify(first.body));
  console.log('采集结果', JSON.stringify({ status: first.status, 包数: first.body.packageCount, 路径: first.body.targets.map(t => `${t.architecture}←${t.fetchedVia}`) }));
  for (const item of first.body.packages) console.log('包记录', item.key);

  const again = await collect(approvedRelease);
  console.log('相同发行重复采集', JSON.stringify({ status: again.status, 全部幂等: again.body.duplicate }));

  const releaseSha = sha256(Buffer.from(approvedRelease, 'utf8'));
  const releaseEvidence = await (await fetch(`${application.url}/api/evidence/${releaseSha}`)).text();
  if (releaseEvidence !== approvedRelease) throw new Error('发行描述原文回查不一致');
  const indexSha = first.body.targets[0].sha256;
  const indexEvidence = Buffer.from(await (await fetch(`${application.url}/api/evidence/${indexSha}`)).arrayBuffer());
  console.log('索引原文回查', JSON.stringify({ 摘要: indexSha.slice(0, 16) + '…', 与发行声明一致: sha256(indexEvidence) === indexSha }));

  const expired = await collect(approvedRelease + 'Valid-Until: Sun, 15 Nov 2020 00:00:00 UTC\n');
  console.log('过期发行', JSON.stringify({ status: expired.status, 结果: expired.body.error }));

  const fallbackSource = await startProvider({ noByHash: true });
  try {
    const fallback = await collect(approvedRelease, fallbackSource.url);
    console.log('by-hash暂缺时回退', JSON.stringify({ status: fallback.status, 路径: fallback.body.targets?.map(t => t.fetchedVia) }));
  } finally { await fallbackSource.close(); }

  const movedSource = await startProvider({ noByHash: true, mutatedIndex: true });
  try {
    const moved = await collect(approvedRelease, movedSource.url);
    console.log('发布进行中且by-hash缺失', JSON.stringify({ status: moved.status, 结果: moved.body.error }));
  } finally { await movedSource.close(); }

  const records = await (await fetch(`${application.url}/api/records`)).json();
  console.log('正式结果', JSON.stringify({ 记录数: records.length, 说明: '过期与校验失败的发行均未混入' }));
} finally {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
