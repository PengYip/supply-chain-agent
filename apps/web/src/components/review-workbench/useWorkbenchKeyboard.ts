// apps/web/src/components/review-workbench/useWorkbenchKeyboard.ts
// 键盘流(spec 2026-09-04 §9): Enter=下一行, F8/Shift+F8=上/下一个问题行,
// Ctrl+Enter=确认当前单据, Ctrl+Shift+Enter=一键放行。
// 输入控件内只放行 Escape(编辑态自己处理), 其余键不拦截。
import { useEffect } from 'react';

export interface WorkbenchKeyboardHandlers {
  onEnter: () => void;
  onF8: (backwards: boolean) => void;
  onConfirmUnit: () => void;
  onReleaseAll: () => void;
}

export function useWorkbenchKeyboard(enabled: boolean, handlers: WorkbenchKeyboardHandlers): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditor =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === 'Escape') return; // 编辑态/弹层自行消费
      if (inEditor) return;
      if (e.key === 'Enter' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        handlers.onReleaseAll();
      } else if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        handlers.onConfirmUnit();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handlers.onEnter();
      } else if (e.key === 'F8') {
        e.preventDefault();
        handlers.onF8(e.shiftKey);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, handlers]);
}