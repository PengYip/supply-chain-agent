import {
  ArrowLeftRight,
  BookOpen,
  Building2,
  FlaskConical,
  FolderKanban,
  Link2,
  MessageSquare,
  Network,
  Star,
  type LucideIcon,
} from 'lucide-react';

/** 视图唯一标识，同时是 hash 路由的一级路径（`#/chat` 等）。 */
export type ViewId =
  | 'chat'
  | 'projects'
  | 'ledger'
  | 'graph'
  | 'bindings'
  | 'flows'
  | 'eval'
  | 'favorites'
  | 'parties';

export type NavGroupId = 'work' | 'admin';

export interface NavItem {
  id: ViewId;
  /** 导航与 AppTopbar 标题共用文案 */
  label: string;
  /** AppTopbar 副标题：一句话说明视图用途 */
  description?: string;
  icon: LucideIcon;
  group: NavGroupId;
  /** false = 已注册未开放（导航不渲染，hash 路由回退 chat） */
  enabled: boolean;
}

/** 视图注册表：路由、导航、顶栏标题的唯一事实源。
 *  分组语义：work = 日常业务高频入口；admin = 低频的配置/质量工具。 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'chat', label: '对话', description: 'DeepSeek + 真实工具调用', icon: MessageSquare, group: 'work', enabled: true },
  { id: 'projects', label: '项目', description: '项目维度汇总（合同面 + 执行面）', icon: FolderKanban, group: 'work', enabled: true },
  { id: 'ledger', label: '项目台账', description: '按项目归集合同的凭证齐套率', icon: BookOpen, group: 'work', enabled: true },
  { id: 'graph', label: '图谱', description: '实体关系可视化', icon: Network, group: 'work', enabled: true },
  { id: 'bindings', label: '绑定', description: '文档与合同绑定工作台', icon: Link2, group: 'work', enabled: true },
  { id: 'flows', label: '执行流水', description: '资金 / 货物 / 发票六向流水', icon: ArrowLeftRight, group: 'work', enabled: true },
  { id: 'eval', label: '评估', description: '评估数据集与结果分析', icon: FlaskConical, group: 'admin', enabled: true },
  { id: 'favorites', label: '收藏反馈', description: '对话收藏与用户反馈', icon: Star, group: 'admin', enabled: true },
  { id: 'parties', label: '己方主体', description: '仅添加你自己的公司', icon: Building2, group: 'admin', enabled: true },
];

export const NAV_GROUPS: Array<{ id: NavGroupId; label: string }> = [
  { id: 'work', label: '工作台' },
  { id: 'admin', label: '管理' },
];

const ENABLED_ITEMS = NAV_ITEMS.filter((item) => item.enabled);

export const NAV_ITEM_MAP: Record<ViewId, NavItem | undefined> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.id, item]),
) as Record<ViewId, NavItem | undefined>;

/** hash 一级路径是否指向一个已开放的视图（未注册或 enabled:false 均视为非法）。 */
export function isRoutableView(id: string): id is ViewId {
  return ENABLED_ITEMS.some((item) => item.id === id);
}
