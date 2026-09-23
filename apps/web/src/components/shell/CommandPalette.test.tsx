// @vitest-environment jsdom
// 命令面板交互断言（菜单重构 2026-09-23）：关键词过滤（含 keywords 别名）+
// Enter 跳转回调 + 空结果兜底。渲染依赖 useSyncExternalStore 外部 store，
// jsdom 下 requestAnimationFrame 可用，聚焦逻辑不参与断言。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CommandPalette } from './CommandPalette';
import { setApprovalPendingCount } from '../../lib/approvalPending';

describe('CommandPalette', () => {
  it('按关键词过滤并在 Enter 时回跳转目标', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open current="overview" onClose={onClose} onNavigate={onNavigate} />);

    const input = screen.getByPlaceholderText('搜索视图，如：审批 / 图谱 / 核销');
    fireEvent.change(input, { target: { value: '核销' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledWith('writeoff');
    expect(onClose).toHaveBeenCalled();
    cleanup();
  });

  it('keywords 别名可命中（英文小写）', () => {
    const onNavigate = vi.fn();
    render(<CommandPalette open current="overview" onClose={vi.fn()} onNavigate={onNavigate} />);

    const input = screen.getByPlaceholderText('搜索视图，如：审批 / 图谱 / 核销');
    // 用量审计并入治理后台（2026-09-23 二期）：OCR/LLM 检索词随迁移
    fireEvent.change(input, { target: { value: 'OCR' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledWith('governance');
    cleanup();
  });

  it('无匹配时显示兜底文案且 Enter 不触发跳转', () => {
    const onNavigate = vi.fn();
    render(<CommandPalette open current="overview" onClose={vi.fn()} onNavigate={onNavigate} />);

    const input = screen.getByPlaceholderText('搜索视图，如：审批 / 图谱 / 核销');
    fireEvent.change(input, { target: { value: '不存在的视图' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByText('没有匹配的视图，换个关键词试试')).toBeTruthy();
    cleanup();
  });

  it('审批中心结果行渲染待办角标', () => {
    setApprovalPendingCount(4);
    render(<CommandPalette open current="overview" onClose={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByText('4')).toBeTruthy();
    setApprovalPendingCount(0);
    cleanup();
  });
});
