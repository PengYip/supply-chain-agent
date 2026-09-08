import {
  ArrowLeftRight,
  Building2,
  ClipboardCheck,
  FlaskConical,
  FolderKanban,
  History,
  LayoutDashboard,
  Link2,
  MessageSquare,
  Network,
  Shield,
  Star,
  type LucideIcon,
} from 'lucide-react';

/** 视图唯一标识，同时是 hash 路由的一级路径（`#/chat` 等）。 */
export type ViewId =
  | 'overview'
  | 'chat'
  | 'approvals'
  | 'projects'
  | 'ontology'
  | 'bindings'
  | 'writeoff'
  | 'governance'
  | 'review'
  | 'eval'
  | 'audit'
  | 'favorites'
  | 'parties';

export type NavGroupId = 'fulfill' | 'ontology' | 'funds' | 'collab' | 'admin';

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
 *  分组语义（导航整合 2026-09-08）：fulfill = 合同履约过程；ontology = 本体数据面；
 *  funds = 资金相关（审批/核销）；collab = 登录门户与对话；admin = 低频的配置/质量工具。 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'projects', label: '项目', description: '项目维度汇总（合同面 + 执行面）', icon: FolderKanban, group: 'fulfill', enabled: true },
  { id: 'bindings', label: '绑定', description: '文档与合同绑定工作台', icon: Link2, group: 'fulfill', enabled: true },
  { id: 'review', label: '集中复核', description: '多页票据表格化批量核对', icon: ClipboardCheck, group: 'fulfill', enabled: true },
  { id: 'ontology', label: '本体', description: '本体台账与本体图谱（实体浏览 / 关系穿透）', icon: Network, group: 'ontology', enabled: true },
  { id: 'approvals', label: '审批中心', description: 'L2/L3 审批待办与历史', icon: ClipboardCheck, group: 'funds', enabled: true },
  { id: 'writeoff', label: '核销', description: '票款核销与预付冲抵（多对多 / 部分金额 / 分批）', icon: ArrowLeftRight, group: 'funds', enabled: true },
  { id: 'overview', label: '总览', description: '待办与异常优先的登录门户', icon: LayoutDashboard, group: 'collab', enabled: true },
  { id: 'chat', label: '对话', description: 'DeepSeek + 真实工具调用', icon: MessageSquare, group: 'collab', enabled: true },
  { id: 'governance', label: '治理后台', description: '本体 / 工具面 / 权限 / 审批审计 只读治理视图', icon: Shield, group: 'admin', enabled: true },
  { id: 'eval', label: '评估', description: '评估数据集与结果分析', icon: FlaskConical, group: 'admin', enabled: true },
  { id: 'audit', label: '用量审计', description: 'LLM 与 OCR 调用统计及明细', icon: History, group: 'admin', enabled: true },
  { id: 'favorites', label: '收藏反馈', description: '对话收藏与用户反馈', icon: Star, group: 'admin', enabled: true },
  { id: 'parties', label: '己方主体', description: '仅添加你自己的公司', icon: Building2, group: 'admin', enabled: true },
];

export const NAV_GROUPS: Array<{ id: NavGroupId; label: string }> = [
  { id: 'fulfill', label: '履约' },
  { id: 'ontology', label: '本体' },
  { id: 'funds', label: '资金' },
  { id: 'collab', label: '协作' },
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
