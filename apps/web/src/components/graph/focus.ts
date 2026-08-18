/** 跨视图定位请求：绑定工作台跳入图谱页时，以指定节点（如合同）为中心展开。 */
export interface GraphFocus {
  /** 目标节点 elementId。 */
  elementId: string;
  /** 展示名，写入图谱页「当前中心」chip。 */
  label: string;
  /** 自增序号：重复定位同一节点也能触发图谱页的 effect。 */
  nonce: number;
}

/** 发起方（绑定工作台）构造定位请求时需要的字段；nonce 由 App 统一分配。 */
export type GraphFocusTarget = Omit<GraphFocus, 'nonce'>;
