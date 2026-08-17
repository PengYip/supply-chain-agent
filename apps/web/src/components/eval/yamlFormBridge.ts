// apps/web/src/components/eval/yamlFormBridge.ts
// 双模式数据集编辑器的 YAML 数据层: 表单组件只经本 bridge 接触 yaml 库 (spec §3)。
// 纯函数模块, 无 React 依赖。
import { parseDocument } from 'yaml';
import type { Document } from 'yaml';

export interface ParseResult {
  ok: boolean;
  doc?: Document;       // ok 时必有
  error?: string;       // 非 ok 时含 yaml 错误信息 (行号若可得)
}

export function parseDatasetYaml(text: string): ParseResult {
  // parseDocument 不抛异常 — 非法 YAML 收在 doc.errors。
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    const line = err.linePos?.[0]?.line;
    const detail = line != null ? `${err.message} (第 ${line} 行附近)` : err.message;
    return { ok: false, error: detail };
  }
  return { ok: true, doc };
}

export function getIn(doc: Document, path: (string | number)[]): unknown {
  return doc.getIn(path); // 缺路径返回 undefined
}

export function setIn(doc: Document, path: (string | number)[], value: unknown): void {
  doc.setIn(path, value); // 对标量/对象字段保注释 (只换值)
}

// 数组增删走「getIn 取整组 → JS 数组改 → setIn 写回整组」策略;
// yaml v2 的 doc.getIn 对集合路径返回 YAMLSeq/YAMLMap 节点, 需先 toJS() 转普通数组。
// 数组内部的注释会丢 (可接受)。
function asJsArray(doc: Document, value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const node = value as { toJS?: (d: Document) => unknown } | null;
  if (node && typeof node.toJS === 'function') {
    const js = node.toJS(doc);
    return Array.isArray(js) ? js : [];
  }
  return [];
}

export function appendListItem(doc: Document, listPath: (string | number)[], item: unknown): void {
  const arr = asJsArray(doc, doc.getIn(listPath));
  arr.push(item);
  doc.setIn(listPath, arr);
}

export function removeListItem(doc: Document, listPath: (string | number)[], index: number): void {
  const arr = asJsArray(doc, doc.getIn(listPath));
  arr.splice(index, 1);
  doc.setIn(listPath, arr);
}

export function docToText(doc: Document): string {
  // lineWidth 0: 长中文行不折行。
  return doc.toString({ lineWidth: 0 });
}
