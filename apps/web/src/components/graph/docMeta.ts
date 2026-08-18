import { createContext, useContext } from 'react';
import { prettyDocName, type DocMeta, type DocMetaResolver } from './kinds';

/**
 * docId -> 展示元数据 的跨层传递。
 * React Flow 的节点卡由 ReactFlow 内部渲染，props 传不进去，走 context；
 * GraphView 用 /api/graph/documents 的列表构建后向整个图谱页提供。
 */
const DocMetaContext = createContext<DocMetaResolver | null>(null);

export const DocMetaProvider = DocMetaContext.Provider;

/** 节点卡/详情等深层组件取解析器；未被 Provider 包裹时返回 null（各处自行优雅降级）。 */
export function useDocMeta(): DocMetaResolver | null {
  return useContext(DocMetaContext);
}

/** 由文档列表（结构兼容 GraphDocument / OverviewDoc）构建 docId 解析器；docId 为空或重复以前者为准跳过。 */
export function buildDocMetaResolver(
  docs: Array<{ docId: string; sourceUri: string; docType: string }>,
): DocMetaResolver {
  const map = new Map<string, DocMeta>();
  for (const d of docs) {
    if (!d.docId) continue;
    map.set(d.docId, {
      name: prettyDocName(d.sourceUri) || d.sourceUri || d.docId,
      docType: d.docType || '',
    });
  }
  return (docId: string) => map.get(docId) ?? null;
}
