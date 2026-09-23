import {
  ArrowLeftRight,
  ClipboardCheck,
  FlaskConical,
  FolderKanban,
  History,
  LayoutDashboard,
  Link2,
  MessageSquare,
  Network,
  Shield,
  Stamp,
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
  | 'favorites';

/** 导航分组（菜单重构 2026-09-23）：work = 高频入口（门户 / 对话）；
 *  biz = 业务主流程（项目 → 绑定 → 复核 → 本体 → 审批 → 核销）；
 *  admin = 低频的管理 / 质量工具。 */
export type NavGroupId = 'work' | 'biz' | 'admin';

export interface NavItem {
  id: ViewId;
  /** 导航与 AppTopbar 标题共用文案 */
  label: string;
  /** AppTopbar 副标题：一句话说明视图用途 */
  description?: string;
  /** 命令面板（Ctrl+K）检索词：label / description / id 之外的别名，小写匹配 */
  keywords?: string[];
  icon: LucideIcon;
  group: NavGroupId;
  /** false = 已注册未开放（导航不渲染，hash 路由回退 overview） */
  enabled: boolean;
  /** 待办角标数据源：目前仅审批中心（pending 总数，store 见 lib/approvalPending.ts） */
  badge?: 'approvalPending';
}

/** 视图注册表：路由、导航、顶栏标题的唯一事实源。
 *  分组语义（菜单重构 2026-09-23，自 2026-09-08 导航整合演进而来）：
 *  work = 登录门户与对话；biz = 合同履约全流程（原 履约/本体/资金 三组合并，
 *  本体是履约的数据面、审批与核销是资金收口，流程上连续不再拆组）；
 *  admin = 治理 / 评估 / 审计 / 反馈等低频工具。 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: '总览', description: '今日待办与异常的统一入口', keywords: ['门户', '首页', '待办', 'dashboard'], icon: LayoutDashboard, group: 'work', enabled: true },
  { id: 'chat', label: '对话', description: '对话式执行业务操作，工具调用全程留痕', keywords: ['助手', 'ai', '会话', '聊天'], icon: MessageSquare, group: 'work', enabled: true },
  { id: 'projects', label: '项目', description: '项目维度汇总（合同面 + 执行面）', keywords: ['合同', '台账', '汇总'], icon: FolderKanban, group: 'biz', enabled: true },
  { id: 'bindings', label: '绑定', description: '文档与合同绑定工作台', keywords: ['挂接', '匹配', '文档'], icon: Link2, group: 'biz', enabled: true },
  { id: 'review', label: '集中复核', description: '多页票据表格化批量核对', keywords: ['核对', '票据', '表格'], icon: ClipboardCheck, group: 'biz', enabled: true },
  { id: 'ontology', label: '本体', description: '实体台账、关系图谱与勾稽缺口', keywords: ['实体', '图谱', '台账', '勾稽', '缺口'], icon: Network, group: 'biz', enabled: true },
  { id: 'approvals', label: '审批中心', description: 'L2/L3 审批待办与历史', keywords: ['审批', '待办', 'l2', 'l3'], icon: Stamp, group: 'biz', enabled: true, badge: 'approvalPending' },
  { id: 'writeoff', label: '核销', description: '票款核销与预付冲抵', keywords: ['冲抵', '预付', '票款'], icon: ArrowLeftRight, group: 'biz', enabled: true },
  { id: 'governance', label: '治理后台', description: '本体、工具面、权限与审批审计（只读）', keywords: ['全景图', '权限', '工具面', '审计'], icon: Shield, group: 'admin', enabled: true },
  { id: 'eval', label: '评估', description: '评估数据集与结果分析', keywords: ['数据集', '回归', '评测'], icon: FlaskConical, group: 'admin', enabled: true },
  { id: 'audit', label: '用量审计', description: 'LLM 与 OCR 调用统计及明细', keywords: ['用量', '成本', 'llm', 'ocr'], icon: History, group: 'admin', enabled: true },
  { id: 'favorites', label: '收藏反馈', description: '对话收藏与用户反馈', keywords: ['收藏', '反馈', '备注'], icon: Star, group: 'admin', enabled: true },
];

export const NAV_GROUPS: Array<{ id: NavGroupId; label: string }> = [
  { id: 'work', label: '工作台' },
  { id: 'biz', label: '业务' },
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
