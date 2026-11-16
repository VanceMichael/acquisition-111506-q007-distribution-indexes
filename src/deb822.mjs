// Deb822 段落解析：Release 发行描述与 Packages 索引共用同一格式。
// 只解析，不信任：Release 的验签发生在调用方既有审批边界内，这里拿到的是已核准文本。

const fail = (message, status = 422) => { throw Object.assign(new Error(message), { status }); };

// 把文本拆成 Deb822 段落。字段行 `Name: value`，续行以空白开头；空行分段。
// 返回 [{ fields: [[name, value], ...], raw }]，raw 是该段落的原文（可追溯）。
export function parseParagraphs(text, what = '文本') {
  if (typeof text !== 'string' || !text.trim()) fail(`${what}为空或不是文本`);
  const paragraphs = [];
  let fields = [];
  let rawLines = [];
  const flush = () => {
    if (fields.length === 0 && rawLines.every(line => !line.trim())) { fields = []; rawLines = []; return; }
    if (fields.length === 0) fail(`${what}存在没有字段的段落`);
    paragraphs.push({ fields, raw: rawLines.join('\n') });
    fields = [];
    rawLines = [];
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) { flush(); continue; }
    rawLines.push(line);
    if (/^[ \t]/.test(line)) {
      if (fields.length === 0) fail(`${what}的续行没有所属字段`);
      fields[fields.length - 1][1] += '\n' + line;
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]?(.*)$/.exec(line);
    if (!match) fail(`${what}存在无法解析的行：${line.slice(0, 80)}`);
    fields.push([match[1], match[2]]);
  }
  flush();
  return paragraphs;
}

// 字段列表转对象；同名字段保留首次出现，原文仍在 raw 中。
export function fieldsToObject(fields) {
  const object = {};
  for (const [name, value] of fields) if (!(name in object)) object[name] = value;
  return object;
}

function parseDateField(value, label) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) fail(`发行描述的${label}无法解析：${value}`);
  return time;
}

// 解析已核准的 Release 发行描述。Suite、Codename、Date、Architectures、
// Components 与 SHA256 映射共同标识发行切面，缺一不可。
export function parseRelease(text) {
  const paragraphs = parseParagraphs(text, '发行描述');
  if (paragraphs.length !== 1) fail('发行描述必须是单个Deb822段落');
  const fields = fieldsToObject(paragraphs[0].fields);
  for (const name of ['Suite', 'Codename', 'Date', 'Architectures', 'Components', 'SHA256']) {
    if (!fields[name] || !fields[name].trim()) fail(`发行描述缺少必要字段：${name}`);
  }
  const architectures = fields.Architectures.trim().split(/\s+/);
  const components = fields.Components.trim().split(/\s+/);
  const indexes = fields.SHA256.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [sha256, size, ...pathParts] = line.split(/\s+/);
    const path = pathParts.join(' ');
    if (!/^[a-f0-9]{64}$/i.test(sha256) || !/^\d+$/.test(size) || !path || path.startsWith('/') || path.includes('..')) {
      fail(`发行描述的SHA256条目无效：${line.slice(0, 120)}`);
    }
    return { sha256: sha256.toLowerCase(), size: Number(size), path };
  });
  if (indexes.length === 0) fail('发行描述的SHA256映射为空');
  const date = parseDateField(fields.Date.trim(), 'Date');
  const validUntilRaw = fields['Valid-Until']?.trim() || null;
  const validUntil = validUntilRaw ? parseDateField(validUntilRaw, 'Valid-Until') : null;
  return {
    suite: fields.Suite.trim(),
    codename: fields.Codename.trim(),
    date, dateRaw: fields.Date.trim(),
    validUntil, validUntilRaw,
    architectures, components, indexes,
    raw: paragraphs[0].raw,
  };
}

// 解析 Packages 索引文本为包段落，保留每段原文。
export function parsePackages(text) {
  return parseParagraphs(text, 'Packages索引').map(({ fields, raw }) => ({ fields: fieldsToObject(fields), raw }));
}
