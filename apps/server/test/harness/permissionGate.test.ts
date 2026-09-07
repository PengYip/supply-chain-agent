import { describe, it, expect } from 'vitest';
import { listPermissions, getPermission, TOOL_PERMISSION_LEVELS } from '../../src/harness/permissionGate.js';

describe('permissionGate snapshot', () => {
  it('levels 词汇 = L1/L2/L3', () => {
    expect([...TOOL_PERMISSION_LEVELS]).toEqual(['L1', 'L2', 'L3']);
  });

  it('listPermissions 含既知声明且层级正确', () => {
    const entries = listPermissions();
    const byName = new Map(entries.map((e) => [e.toolName, e.level]));
    expect(byName.get('query_business')).toBe('L1');
    expect(byName.get('bind_document')).toBe('L2');
    expect(byName.get('create_writeoff')).toBe('L2');
    // L3 当前无注册工具（permissionGate 头注：money/irreversible 不落系统内工具）
    expect([...byName.values()].filter((l) => l === 'L3')).toHaveLength(0);
  });

  it('未注册工具 getPermission 兜底 L1（快照不包含兜底项）', () => {
    expect(getPermission('no_such_tool')).toBe('L1');
    expect(listPermissions().some((e) => e.toolName === 'no_such_tool')).toBe(false);
  });
});
