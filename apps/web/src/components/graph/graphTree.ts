// 项目树(spec 2026-08-27 Task6): GET /api/graph/tree 的前端契约与纯函数处理。
// 归一化对齐 useGraph.getJson 宽松风格；arrangeTree 供面板渲染与单测复用。
import type { GraphDocument } from '../../hooks/useGraph';

export interface GraphTreeDoc {
  elementId: string;
  name: string;
}
export interface GraphTreeContract {
  elementId: string;
  name: string;
  docs: GraphTreeDoc[];
}
export interface GraphTreeProject {
  elementId: string;
  name: string;
  contracts: GraphTreeContract[];
}
export interface GraphTree {
  projects: GraphTreeProject[];
  /** 未归属任何项目的合同(连同其履约单据)，前端渲染为「未分组」区。 */
  orphanContracts: GraphTreeContract[];
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function normDocs(raw: unknown): GraphTreeDoc[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((r) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      return { elementId: asStr(o.elementId), name: asStr(o.name) };
    })
    .filter((d) => d.elementId);
}

function normContracts(raw: unknown): GraphTreeContract[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((r) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      return { elementId: asStr(o.elementId), name: asStr(o.name), docs: normDocs(o.docs) };
    })
    .filter((c) => c.elementId);
}

/** 服务端载荷 -> GraphTree（宽松归一化，坏字段静默丢弃）。 */
export function normalizeTree(raw: unknown): GraphTree {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const projects = (Array.isArray(o.projects) ? o.projects : [])
    .map((p) => {
      const po = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
      return { elementId: asStr(po.elementId), name: asStr(po.name), contracts: normContracts(po.contracts) };
    })
    .filter((p) => p.elementId);
  return { projects, orphanContracts: normContracts(o.orphanContracts) };
}

/** 树内全部文档 elementId 集合(选中态比对用)。 */
export function treeDocIds(tree: GraphTree | null): Set<string> {
  const ids = new Set<string>();
  if (!tree) return ids;
  for (const p of tree.projects) {
    for (const c of p.contracts) {
      for (const d of c.docs) ids.add(d.elementId);
    }
  }
  for (const c of tree.orphanContracts) {
    for (const d of c.docs) ids.add(d.elementId);
  }
  return ids;
}

/** 在已入库文档列表里为树文档补齐展示元数据(文件名/业务类型兜底)。 */
export function findDocMeta(documents: GraphDocument[], elementId: string): GraphDocument | null {
  return documents.find((d) => d.elementId === elementId) ?? null;
}

/** 展开态工具：默认展开所有项目节点，返回受控 key 集合。 */
export function defaultExpandedProjects(tree: GraphTree | null): Set<string> {
  const keys = new Set<string>();
  if (!tree) return keys;
  for (const p of tree.projects) keys.add(p.elementId);
  return keys;
}
