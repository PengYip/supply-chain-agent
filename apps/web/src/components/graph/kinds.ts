import type { GraphNode } from '../../hooks/useGraph';

/** 四类节点的配色与文案：全部取自现有自定义色板，融入 deepSea 主色系。 */
export interface KindStyle {
  /** 主色（图标/圆点/小地图） */
  color: string;
  /** 徽章底色（主色的浅色阶） */
  softBg: string;
  /** 徽章描边 */
  softBorder: string;
  /** 中文标签 */
  label: string;
}

export const KIND_STYLES: Record<string, KindStyle> = {
  Document: { color: '#0F3A5C', softBg: '#E8EEF4', softBorder: '#C7D6E3', label: '文档' },
  Party: { color: '#4A6D8C', softBg: '#EBF1F5', softBorder: '#CFDCE6', label: '交易方' },
  Commodity: { color: '#D97706', softBg: '#FBF0DE', softBorder: '#F0D9B0', label: '商品' },
  Contract: { color: '#15803D', softBg: '#E9F4EC', softBorder: '#CBE5D3', label: '合同' },
};

const FALLBACK_STYLE: KindStyle = { color: '#6B7280', softBg: '#F3F4F6', softBorder: '#E5E7EB', label: '节点' };

export function kindStyle(kind: string): KindStyle {
  return KIND_STYLES[kind] ?? FALLBACK_STYLE;
}

/** 边类型的中文标签（未知类型原样展示）。 */
export const EDGE_LABELS: Record<string, string> = {
  party: '交易方',
  commodity: '商品',
  references: '引用',
  executes: '履行',
};

export function edgeLabel(type: string): string {
  return EDGE_LABELS[type] ?? type;
}

/** 展示名兜底：空名显示占位。 */
export function nodeDisplayName(node: Pick<GraphNode, 'name' | 'kind'>): string {
  return node.name || `${kindStyle(node.kind).label}（未命名）`;
}

/** 从 sourceUri 提取可读文件名：取末段，剥掉 MinIO 扁平化带来的 uuid 前缀。 */
export function prettyDocName(sourceUri: string): string {
  const base = sourceUri.split('/').pop() || sourceUri;
  const uuidPrefix = base.match(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-(.+)$/,
  );
  return uuidPrefix ? uuidPrefix[1] : base;
}
