export const product = "镜像目录收件服务";
export const requiredFields = ["packageId", "package", "version", "architecture"];
export const businessKey = "packageId";

export function validateRecord(input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('收件内容必须是对象');
  for (const field of requiredFields) if (!(field in input) || input[field] === null) fail(`缺少业务字段：${field}`);
  if (typeof input[businessKey] !== 'string' || !input[businessKey].trim() || input[businessKey].length > 512) fail('业务标识无效');
  const record = structuredClone(input);
  return { key: record[businessKey], record };
}
