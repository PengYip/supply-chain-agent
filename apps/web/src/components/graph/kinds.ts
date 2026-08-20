import { Building2, FileSignature, FileText, FolderKanban, Package, type LucideIcon } from 'lucide-react';
import type { GraphNode } from '../../hooks/useGraph';

/** 五类节点的图标（主/迷你画布节点共用）。 */
export const KIND_ICONS: Record<string, LucideIcon> = {
  Document: FileText,
  Party: Building2,
  Commodity: Package,
  Contract: FileSignature,
  Project: FolderKanban,
};

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
  Project: { color: '#6D5FC3', softBg: '#EEEBF8', softBorder: '#D8D0F0', label: '项目' },
};

const FALLBACK_STYLE: KindStyle = { color: '#6B7280', softBg: '#F3F4F6', softBorder: '#E5E7EB', label: '节点' };

/* 预编译的 uuid 匹配（8-4-4-4-12 hex）。 */
const UUID_HEX = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** 串首或下划线之后引出的 <uuid>-，后接到串尾的文件名。限定起点避免误切文件名中段。 */
const INLINE_UUID_NAME = new RegExp(`(?:^|_)${UUID_HEX}-(.+)$`);
/** 扁平化 key 的 users_<userId>_ 前缀（userId 是 uuid，不含下划线）。 */
const USERS_UUID_PREFIX = new RegExp(`^users_${UUID_HEX}_(.+)$`);

export function kindStyle(kind: string): KindStyle {
  return KIND_STYLES[kind] ?? FALLBACK_STYLE;
}

/** 边类型的中文标签（未知类型原样展示）。 */
export const EDGE_LABELS: Record<string, string> = {
  party: '交易方',
  commodity: '商品',
  references: '引用',
  executes: '履行',
  binds: '绑定',
  part_of: '归属',
  counterparty: '对手方',
  participates: '参与',
};

/** 边样式覆盖: binds(人工确认的绑定)与抽取级提及边视觉区分。 */
export const EDGE_STYLE_OVERRIDES: Record<string, { color: string; dashed: boolean }> = {
  binds: { color: '#15803D', dashed: true },
};

export function edgeLabel(type: string): string {
  return EDGE_LABELS[type] ?? type;
}

/** docId 对应的展示元数据：原始文件名 + 业务类型。由文档列表构建，用于补齐老图谱 Document 节点缺失的 props。 */
export interface DocMeta {
  /** 可读文件名（已剥 uuid/前缀）。 */
  name: string;
  /** 业务类型（合同/发票/物流单据...，可能为空串）。 */
  docType: string;
}

/** docId -> 展示元数据 解析器；未命中返回 null。 */
export type DocMetaResolver = (docId: string) => DocMeta | null;

/** Document 节点的 docId：优先 props.docId，老数据回退 node.name（绑定同步兜底路径里 name 即 docId）。 */
export function docIdOf(node: Pick<GraphNode, 'name' | 'props'>): string {
  const p = node.props?.docId;
  return typeof p === 'string' && p ? p : node.name;
}

/** 展示名：Document 节点优先从 props.sourceUri 解析原始文件名；缺失时用文档列表按 docId 兜底；最后回退 name / 占位。 */
export function nodeDisplayName(
  node: Pick<GraphNode, 'name' | 'kind' | 'props'>,
  docMeta?: DocMetaResolver | null,
): string {
  if (node.kind === 'Document') {
    const uri = node.props?.sourceUri;
    if (typeof uri === 'string' && uri) {
      const fileName = prettyDocName(uri);
      if (fileName) return fileName;
    }
    if (docMeta) {
      const meta = docMeta(docIdOf(node));
      if (meta?.name) return meta.name;
    }
  }
  return node.name || `${kindStyle(node.kind).label}（未命名）`;
}

/** Document 节点的业务类型：props.docType 优先，缺失时用文档列表按 docId 兜底；都无则返回空串（调用方显示「文档」）。 */
export function docTypeName(
  node: Pick<GraphNode, 'name' | 'kind' | 'props'>,
  docMeta?: DocMetaResolver | null,
): string {
  if (node.kind !== 'Document') return '';
  const fromProps = node.props?.docType;
  if (typeof fromProps === 'string' && fromProps) return fromProps;
  if (docMeta) {
    const meta = docMeta(docIdOf(node));
    if (meta?.docType) return meta.docType;
  }
  return '';
}

/** 从 sourceUri 提取可读文件名。兼容两类形态：
 *  - MinIO 对象 key（/ 分隔，末段形如 <uuid>-文件名）
 *  - INGEST_ROOT 扁平化路径（key 的 / 被替换为 _，如 users_<userId>_合同_<uuid>-文件名.pdf）
 *  先取 / 末段；再匹配「串首或 _ 引出的 <uuid>-」取其后文件名；无 uuid 则剥 users_<userId>_ 前缀；兜底返回末段。 */
export function prettyDocName(sourceUri: string): string {
  if (!sourceUri) return '';
  const base = sourceUri.split('/').pop() || sourceUri;
  const inlineUuid = INLINE_UUID_NAME.exec(base);
  if (inlineUuid) return inlineUuid[1];
  const usersPrefix = USERS_UUID_PREFIX.exec(base);
  if (usersPrefix) return usersPrefix[1];
  return base;
}
