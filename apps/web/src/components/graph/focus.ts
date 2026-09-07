/** 跨视图定位请求(roadmap Item 4 起)：文档图谱模式(elementId)或本体穿透模式(entityType+entityId)。 */
export type GraphFocusTarget =
  | { elementId: string; label: string }
  | { entityType: string; entityId: string; label: string };

export interface GraphFocus {
  /** 自增序号：重复定位同一目标也能触发图谱页的 effect。 */
  nonce: number;
  target: GraphFocusTarget;
}