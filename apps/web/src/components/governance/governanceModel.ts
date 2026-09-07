// apps/web/src/components/governance/governanceModel.ts
// 治理后台四个 tab 的纯展示逻辑：全部由接口数据驱动，不硬编码业务字段。
import type { ToolInventoryItemDTO, PermissionSnapshotDTO } from '../../api/governance';

export type { ToolInventoryItemDTO, PermissionSnapshotDTO };

export interface ToolRowFlags {
  /** inventory 已标 deprecated 但注册表仍挂载：如实呈现，不掩饰。 */
  deprecatedMounted: boolean;
  /** mount=env：部署未开启时注册表实测不挂载。 */
  envGated: boolean;
}

export function toolRowFlags(t: ToolInventoryItemDTO): ToolRowFlags {
  return {
    deprecatedMounted: t.status === 'deprecated' && t.registry.mounted,
    envGated: t.mount === 'env',
  };
}

export interface MatrixRow {
  toolName: string;
  level: string;
}

export function permissionMatrixRows(
  snapshot: PermissionSnapshotDTO,
): { levels: string[]; rows: MatrixRow[] } {
  return {
    levels: snapshot.levels,
    rows: snapshot.entries.map((e) => ({ toolName: e.toolName, level: e.level })),
  };
}
