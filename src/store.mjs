
import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function openStore(directory) {
  await mkdir(join(directory, 'blobs'), { recursive: true });
  const journal = join(directory, 'receipts.jsonl');
  let receipts;
  try {
    receipts = (await readFile(journal, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    receipts = [];
  }
  let pending = Promise.resolve();
  const serialize = operation => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  const api = {
    list() {
      const latest = new Map();
      for (const receipt of receipts) latest.set(receipt.key, receipt);
      return structuredClone([...latest.values()]);
    },
    history(key) {
      return structuredClone(receipts.filter(receipt => receipt.key === key));
    },
    async evidence(sha) {
      if (!/^[a-f0-9]{64}$/.test(sha)) throw Object.assign(new Error('依据标识无效'), { status: 400 });
      return readFile(join(directory, 'blobs', sha));
    },
    accept(key, record, evidence) {
      return api.acceptBatch([{ key, record, evidence }]).then(receipts => receipts[0]);
    },
    // 批量收件：全部条目校验通过、一次性追加日志，避免半个发行混入正式结果。
    acceptBatch(entries) {
      return serialize(async () => {
        if (!Array.isArray(entries) || entries.length === 0 || entries.length > 5000) {
          throw Object.assign(new Error('批量收件需要1至5000条'), { status: 422 });
        }
        const prepared = entries.map(entry => {
          const { key, record, evidence } = entry ?? {};
          if (typeof key !== 'string' || !key.trim() || key.length > 512) {
            throw Object.assign(new Error('业务标识无效'), { status: 422 });
          }
          if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw Object.assign(new Error('收件内容必须是对象'), { status: 422 });
          }
          if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 30) {
            throw Object.assign(new Error('收件需要原始依据，单次不超过30份'), { status: 422 });
          }
          const items = evidence.map(item => {
            if (!item || typeof item.source !== 'string' || !item.source.trim() || typeof item.bytesBase64 !== 'string') {
              throw Object.assign(new Error('依据必须包含来源和原始字节'), { status: 422 });
            }
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.bytesBase64)) {
              throw Object.assign(new Error('依据不是标准Base64'), { status: 422 });
            }
            const bytes = Buffer.from(item.bytesBase64, 'base64');
            const sha256 = digest(bytes);
            if (item.sha256 && item.sha256 !== sha256) throw Object.assign(new Error('依据哈希不匹配'), { status: 422 });
            return { bytes, ref: { source: item.source, mediaType: item.mediaType ?? 'application/octet-stream', sha256, size: bytes.length } };
          });
          const refs = items.map(item => item.ref);
          return { key, record: structuredClone(record), items, refs, identity: digest(JSON.stringify({ key, record, refs })) };
        });
        const results = [];
        const fresh = [];
        for (const item of prepared) {
          const existing = receipts.find(receipt => receipt.identity === item.identity)
            ?? fresh.find(receipt => receipt.identity === item.identity);
          if (existing) { results.push({ ...structuredClone(existing), duplicate: true }); continue; }
          for (const blob of item.items) {
            try {
              await writeFile(join(directory, 'blobs', blob.ref.sha256), blob.bytes, { flag: 'wx' });
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
            }
          }
          const receipt = {
            sequence: receipts.length + fresh.length + 1,
            identity: item.identity,
            key: item.key,
            record: item.record,
            evidence: item.refs,
            receivedAt: new Date().toISOString(),
          };
          fresh.push(receipt);
          results.push({ ...structuredClone(receipt), duplicate: false });
        }
        if (fresh.length > 0) {
          await appendFile(journal, fresh.map(receipt => JSON.stringify(receipt)).join('\n') + '\n');
          receipts.push(...fresh);
        }
        return results;
      });
    },
    flush() { return pending; },
  };
  return api;
}
