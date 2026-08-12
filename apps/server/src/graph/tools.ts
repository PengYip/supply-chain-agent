import { tool } from 'ai';
import { z } from 'zod';
import { createEntity, linkEntities, graphQuery } from './repo.js';

export function buildCreateEntityTool() {
  return tool({
    description:
      '创建一个非文档实体节点 (如 Party 买方/卖方, Commodity 商品, Contract 合同). 按 kind+name 去重, 已存在则返回既有 elementId. props 为开放的属性 map.',
    inputSchema: z.object({
      kind: z.string().min(1).describe('实体类型, 如 Party/Commodity/Contract (开放字符串)'),
      name: z.string().min(1).describe('实体名称, 作为同类去重键'),
      props: z.record(z.string(), z.unknown()).optional().describe('开放属性'),
    }),
    execute: async ({ kind, name, props }) => {
      const e = await createEntity({ kind, name, props });
      return {
        status: 'ok' as const,
        elementId: e.elementId,
        kind: e.kind,
        name: e.name,
        created: e.created,
      };
    },
  });
}

export function buildLinkEntitiesTool() {
  return tool({
    description:
      '在两个已存在的实体之间创建一条有向关系 (如 buyer_of / plays_role / references). src/dst 必须是 create_entity 返回的 elementId. 不会隐式创建节点.',
    inputSchema: z.object({
      srcId: z.string().min(1).describe('源实体 elementId'),
      dstId: z.string().min(1).describe('目标实体 elementId'),
      kind: z.string().min(1).describe('关系类型 (开放字符串, 如 buyer_of)'),
      props: z.record(z.string(), z.unknown()).optional(),
      confidence: z.number().min(0).max(1).optional(),
      sourceSpan: z.unknown().optional(),
    }),
    execute: async ({ srcId, dstId, kind, props, confidence, sourceSpan }) => {
      const edge = await linkEntities({ srcId, dstId, kind, props, confidence, sourceSpan });
      return {
        status: 'ok' as const,
        edgeId: edge.elementId,
        type: edge.type,
        srcId: edge.srcId,
        dstId: edge.dstId,
      };
    },
  });
}

export function buildGraphQueryTool() {
  return tool({
    description:
      '从某个实体出发, 在图中做有界遍历 (默认深度 2), 返回邻接节点与边的摘要 (不含原始文档文本). 用于回答 "这份合同关联了哪些实体" 一类问题.',
    inputSchema: z.object({
      subject: z.string().min(1).describe('起始实体 elementId'),
      depth: z.number().int().min(1).max(5).optional().describe('遍历深度, 默认 2'),
      edgeKinds: z.array(z.string().min(1)).optional().describe('仅遍历这些关系类型'),
      direction: z.enum(['out', 'in', 'both']).optional().describe('方向, 默认 both'),
    }),
    execute: async ({ subject, depth, edgeKinds, direction }) => {
      const res = await graphQuery({ subjectId: subject, depth, edgeKinds, direction });
      return {
        status: 'ok' as const,
        subject: { elementId: res.subject.elementId, kind: res.subject.kind, name: res.subject.name },
        nodes: res.nodes.map((n) => ({ elementId: n.elementId, kind: n.kind, name: n.name })),
        edges: res.edges.map((e) => ({ type: e.type, srcId: e.srcId, dstId: e.dstId, confidence: e.confidence })),
      };
    },
  });
}
