import { useState } from 'react';
import clsx from 'clsx';
import { useSessions } from '../../hooks/useSessions';
import { SessionSidebar } from '../SessionSidebar';
import { RealChatView } from '../RealChatView';
import { PanelRail } from '../shell/PanelRail';

/** 对话工作区：左侧可折叠会话面板 + 右侧消息流。
 *  会话列表从全局布局收进对话视图（原为 App 级常驻 260px，其他视图白占空间）。
 *  App 仍持有唯一 useSessions 实例并经 sessionsApi 透传，保持
 *  「侧栏数据与 RealChatView 刷新触发共享同一实例」的既有契约。 */
export function ChatWorkspace({
  activeSessionId,
  onSelectSession,
  sessionsApi,
  chat,
}: {
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  sessionsApi: ReturnType<typeof useSessions>;
  /** RealChatView 其余 props 原样透传（sessionId 单独传入）。 */
  chat: Omit<React.ComponentProps<typeof RealChatView>, 'sessionId'>;
}) {
  // 面板折叠（默认展开，不持久化），与图谱/绑定面板同一交互语言
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-full min-w-0">
      <div
        className={clsx(
          'h-full shrink-0 overflow-hidden transition-[width] duration-200',
          collapsed ? 'w-0' : 'w-64',
        )}
      >
        <SessionSidebar
          activeSessionId={activeSessionId}
          onSelect={onSelectSession}
          sessions={sessionsApi.sessions}
          loading={sessionsApi.loading}
          createSession={sessionsApi.createSession}
          deleteSession={sessionsApi.deleteSession}
          favoriteSession={sessionsApi.favoriteSession}
          unfavoriteSession={sessionsApi.unfavoriteSession}
        />
      </div>
      <PanelRail
        collapsed={collapsed}
        side="left"
        label="会话"
        onToggle={() => setCollapsed((v) => !v)}
      />
      <RealChatView sessionId={activeSessionId} {...chat} />
    </div>
  );
}
