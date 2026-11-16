// 从已核准的发行描述（Release）出发采集索引元数据。
// 一致性原则：发行描述由调用方在既有审批边界内验签后提交；本模块不获取、
// 不信任任何密钥。每个索引字节都必须命中发行描述里的 SHA256+大小声明，
// 任何一步失败则整个发行不进入正式结果（不产生混合目录）。只采元数据，
// 不下载 Filename 指向的软件包。

import { gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { digest } from './store.mjs';
import { parseRelease, parsePackages } from './deb822.mjs';

const gunzip = promisify(gunzipCallback);
const fail = (message, status = 422) => { throw Object.assign(new Error(message), { status }); };

const SUPPORTED = new Set(['gzip', 'plain']);

// 路径的压缩表示。发行可能暂时缺少某一种表示，采集方按发行声明选择。
export function representationOf(path) {
  if (path.endsWith('.gz')) return 'gzip';
  if (path.endsWith('.xz')) return 'xz';
  if (path.endsWith('.zst')) return 'zstd';
  if (/\/Packages$/.test(path)) return 'plain';
  return 'unknown';
}

// 发行描述校验：结构必需字段之外，过期发行不得进入正式结果。
export function validateRelease(release, now = new Date()) {
  if (release.validUntil && now.getTime() > release.validUntil.getTime()) {
    fail(`发行描述已过期（Valid-Until: ${release.validUntilRaw}），不进入正式结果`, 422);
  }
  return release;
}

// 组件 × 架构 的采集目标。Architecture: all 没有独立索引，随各架构索引分发。
export function planTargets(release) {
  const arches = release.architectures.filter(arch => arch !== 'all');
  if (arches.length === 0) fail('发行描述没有可采集的具体架构');
  const targets = [];
  for (const component of release.components) {
    for (const architecture of arches) {
      const prefix = `${component}/binary-${architecture}/Packages`;
      const candidates = release.indexes.filter(entry => entry.path === prefix || entry.path.startsWith(prefix + '.'));
      if (candidates.length === 0) fail(`发行描述缺少索引声明：${component}/binary-${architecture}`);
      targets.push({ component, architecture, candidates });
    }
  }
  return targets;
}

async function fetchBytes(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch {
    return { ok: false, note: '请求失败' };
  }
  if (!response.ok) return { ok: false, note: `HTTP ${response.status}` };
  return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) };
}

// 单个候选索引：优先 by-hash 固定路径，回退普通路径；两条路径拿到的字节
// 都必须与发行描述声明的 SHA256 和大小一致，否则不算该发行的内容。
async function fetchCandidate(fetchImpl, indexBase, entry) {
  const directory = entry.path.slice(0, entry.path.lastIndexOf('/'));
  const attempts = [
    { via: 'by-hash', url: `${indexBase}/${directory}/by-hash/SHA256/${entry.sha256}` },
    { via: 'path', url: `${indexBase}/${entry.path}` },
  ];
  const notes = [];
  for (const attempt of attempts) {
    const result = await fetchBytes(fetchImpl, attempt.url);
    if (!result.ok) { notes.push(`${attempt.via}: ${result.note}`); continue; }
    if (result.bytes.length !== entry.size) { notes.push(`${attempt.via}: 大小与发行声明不符`); continue; }
    if (digest(result.bytes) !== entry.sha256) { notes.push(`${attempt.via}: 摘要与发行声明不符`); continue; }
    return { ok: true, ...attempt, bytes: result.bytes, notes };
  }
  return { ok: false, notes };
}

async function decompress(representation, bytes) {
  if (representation === 'gzip') return gunzip(bytes);
  if (representation === 'plain') return bytes;
  fail(`不支持的索引压缩表示：${representation}`, 422);
}

// 采集一个目标：按发行声明顺序尝试候选表示，跳过不支持的表示。
async function collectTarget(fetchImpl, indexBase, target) {
  const skipped = [];
  for (const entry of target.candidates) {
    const representation = representationOf(entry.path);
    if (!SUPPORTED.has(representation)) { skipped.push(`${entry.path}: 表示 ${representation} 不支持`); continue; }
    const fetched = await fetchCandidate(fetchImpl, indexBase, entry);
    if (!fetched.ok) { skipped.push(`${entry.path}: ${fetched.notes.join('；')}`); continue; }
    const textBytes = await decompress(representation, fetched.bytes);
    return {
      component: target.component,
      architecture: target.architecture,
      path: entry.path,
      representation,
      fetchedVia: fetched.via,
      url: fetched.url,
      sha256: entry.sha256,
      size: entry.size,
      rawBytes: fetched.bytes,
      textBytes,
      paragraphs: parsePackages(textBytes.toString('utf8')),
    };
  }
  fail(`索引采集失败：${target.component}/binary-${target.architecture}（${skipped.join('；') || '无可用候选'}）`, 502);
}

const REQUIRED_PACKAGE_FIELDS = ['Package', 'Version', 'Architecture', 'Filename', 'Size', 'SHA256'];

// 把各目标索引的包段落合并为包记录。包身份 = 组件+包名+版本+架构，
// 同名多版本、不同架构必须并存；Architecture: all 只保留一条记录，
// 它与具体架构的适用关系记入 appliesTo，不复制成多条独立记录。
export function mergePackageRecords(targets, release, releaseSha) {
  const merged = new Map();
  for (const target of targets) {
    for (const { fields, raw } of target.paragraphs) {
      for (const name of REQUIRED_PACKAGE_FIELDS) {
        if (!fields[name] || !fields[name].trim()) fail(`索引段落缺少必要字段：${name}（${target.path}）`, 502);
      }
      if (!/^\d+$/.test(fields.Size.trim()) || !/^[a-f0-9]{64}$/i.test(fields.SHA256.trim())) {
        fail(`索引段落字段无效：${fields.Package}（${target.path}）`, 502);
      }
      const identity = [target.component, fields.Package, fields.Version, fields.Architecture].join(' ');
      const existing = merged.get(identity);
      if (existing) {
        if (existing.filename !== fields.Filename.trim() || existing.sha256 !== fields.SHA256.trim() || existing.size !== Number(fields.Size)) {
          fail(`同一发行内包记录冲突：${fields.Package} ${fields.Version} ${fields.Architecture}`, 502);
        }
        if (!existing.appliesTo.includes(target.architecture)) existing.appliesTo.push(target.architecture);
        if (!existing.sourcePaths.includes(target.path)) existing.sourcePaths.push(target.path);
        continue;
      }
      merged.set(identity, {
        package: fields.Package.trim(),
        version: fields.Version.trim(),
        architecture: fields.Architecture.trim(),
        component: target.component,
        appliesTo: [target.architecture],
        filename: fields.Filename.trim(),
        size: Number(fields.Size),
        sha256: fields.SHA256.trim(),
        ...(fields.Description ? { description: fields.Description } : {}),
        sourcePaths: [target.path],
        raw,
      });
    }
  }
  const releaseRef = { suite: release.suite, codename: release.codename, date: release.dateRaw, sha256: releaseSha };
  return [...merged.values()].map(record => ({
    kind: 'package',
    ...record,
    appliesTo: [...record.appliesTo].sort(),
    release: releaseRef,
  }));
}

// 汇总采集结果为收件批次：每个包一条记录，外加一条采集完整性记录；
// 每条记录都绑定发行描述、组件、架构，并引用可追溯的索引原文依据。
export function buildEntries({ release, releaseSha, releaseBytes, approvalSource, indexBase, targets, packages }) {
  const blobs = new Map();
  const blob = (source, bytes, mediaType) => {
    const sha256 = digest(bytes);
    if (!blobs.has(sha256)) blobs.set(sha256, { source, mediaType, bytesBase64: bytes.toString('base64') });
    return sha256;
  };
  const releaseEvidenceSha = blob(approvalSource, releaseBytes, 'text/plain');
  const targetEvidence = new Map();
  for (const target of targets) {
    targetEvidence.set(target.path, [
      blob(target.url, target.rawBytes, target.representation === 'gzip' ? 'application/gzip' : 'text/plain'),
      blob(`${target.url}#decompressed`, target.textBytes, 'text/plain'),
    ]);
  }
  const evidenceOf = shas => [...new Set(shas)].map(sha => ({ sha256: sha, ...blobs.get(sha) }));
  const entries = packages.map(record => {
    const key = `auto:${record.component}:${record.package}:${record.version}:${record.architecture}`;
    const shas = [releaseEvidenceSha, ...record.sourcePaths.flatMap(path => targetEvidence.get(path))];
    return { key, record: { packageId: key, ...record }, evidence: evidenceOf(shas) };
  });
  const summaryKey = `collection:${releaseSha}`;
  const summary = {
    kind: 'collection',
    packageId: summaryKey,
    release: {
      suite: release.suite,
      codename: release.codename,
      date: release.dateRaw,
      validUntil: release.validUntilRaw,
      architectures: release.architectures,
      components: release.components,
      sha256: releaseSha,
    },
    indexBase,
    targets: targets.map(target => ({
      component: target.component,
      architecture: target.architecture,
      path: target.path,
      representation: target.representation,
      fetchedVia: target.fetchedVia,
      url: target.url,
      sha256: target.sha256,
      size: target.size,
      packages: target.paragraphs.length,
    })),
    packageCount: packages.length,
  };
  entries.push({
    key: summaryKey,
    record: summary,
    evidence: evidenceOf([releaseEvidenceSha, ...targets.flatMap(target => targetEvidence.get(target.path))]),
  });
  return { entries, summary };
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('采集请求必须是对象');
  const release = input.release;
  if (!release || typeof release !== 'object') fail('采集请求缺少已核准的发行描述');
  if (typeof release.source !== 'string' || !release.source.trim()) fail('发行描述需要核准来源标识');
  if (typeof release.bytesBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(release.bytesBase64)) {
    fail('发行描述不是标准Base64');
  }
  if (typeof input.indexBase !== 'string' || !input.indexBase.trim()) fail('采集请求缺少索引基点');
  try {
    const parsed = new URL(input.indexBase);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
  } catch {
    fail('索引基点必须是http(s)地址');
  }
  return { release, indexBase: input.indexBase.replace(/\/+$/, '') };
}

// 采集入口：核准发行描述 → 校验 → 按声明取齐全部索引并逐条验证 →
// 全部通过才一次性写入正式结果；任何失败都不产生部分结果。
export async function collectFromApproval(store, input, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? new Date();
  const { release: approved, indexBase } = validateInput(input);
  const releaseBytes = Buffer.from(approved.bytesBase64, 'base64');
  const releaseSha = digest(releaseBytes);
  if (approved.sha256 && approved.sha256 !== releaseSha) fail('发行描述与核准摘要不符', 422);
  const release = validateRelease(parseRelease(releaseBytes.toString('utf8')), now);
  const planned = planTargets(release);
  const targets = [];
  for (const target of planned) targets.push(await collectTarget(fetchImpl, indexBase, target));
  const packages = mergePackageRecords(targets, release, releaseSha);
  const { entries, summary } = buildEntries({
    release, releaseSha, releaseBytes,
    approvalSource: approved.source.trim(),
    indexBase, targets, packages,
  });
  const receipts = await store.acceptBatch(entries);
  const collection = receipts[receipts.length - 1];
  return {
    duplicate: receipts.every(receipt => receipt.duplicate),
    collection,
    release: summary.release,
    targets: summary.targets,
    packages: receipts.slice(0, -1).map(receipt => ({ key: receipt.key, duplicate: receipt.duplicate })),
    packageCount: packages.length,
  };
}
