import { describe, it, expect } from 'vitest';
import { toolRowFlags, permissionMatrixRows, type ToolInventoryItemDTO, type PermissionSnapshotDTO } from './governanceModel';

const tool = (over: Partial<ToolInventoryItemDTO>): ToolInventoryItemDTO => ({
  name: 'x', layer: '感知', level: 'L1', group: '台账查询', status: 'active', mount: 'always',
  whenToUse: '', boundary: '', rationale: '', registry: { mounted: true, needsApproval: false },
  ...over,
});

describe('toolRowFlags', () => {
  it('deprecated 且仍挂载 = 如实标记（Item 6 硬要求）', () => {
    expect(toolRowFlags(tool({ status: 'deprecated', registry: { mounted: true, needsApproval: false } })))
      .toEqual({ deprecatedMounted: true, envGated: false });
  });
  it('active 挂载、env 门控分别判定', () => {
    expect(toolRowFlags(tool({}))).toEqual({ deprecatedMounted: false, envGated: false });
    expect(toolRowFlags(tool({ mount: 'env', requiresEnv: 'CUBE_SANDBOX_ENABLED=true' })))
      .toEqual({ deprecatedMounted: false, envGated: true });
    expect(toolRowFlags(tool({ status: 'deprecated', registry: { mounted: false, needsApproval: false } })).deprecatedMounted)
      .toBe(false);
  });
});

describe('permissionMatrixRows', () => {
  it('行=工具，levels 从快照带出（不硬编码）', () => {
    const snap: PermissionSnapshotDTO = {
      source: 's', levels: ['L1', 'L2', 'L3'],
      entries: [
        { toolName: 'query_business', level: 'L1' },
        { toolName: 'bind_document', level: 'L2' },
      ],
      note: '',
    };
    const { levels, rows } = permissionMatrixRows(snap);
    expect(levels).toEqual(['L1', 'L2', 'L3']);
    expect(rows).toEqual([
      { toolName: 'query_business', level: 'L1' },
      { toolName: 'bind_document', level: 'L2' },
    ]);
  });
});
