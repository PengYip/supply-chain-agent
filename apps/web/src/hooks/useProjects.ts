import { useCallback, useEffect, useState } from 'react';
import {
  listProjects, createProject, listMemberships, assignMembership,
  confirmMembership, rejectMembership, fetchProjectRollup,
  type ProjectSummary, type ProjectMembership, type ProjectRollupResp,
} from '../api/projects';

/* ---------- 项目工作台数据 Hook(照 useBindings/useParties 模式) ----------
 *
 * 左栏: 项目列表(含 membershipCount/proposedCount 计数) + 新建表单。
 * 右栏: 选中项目的归属列表 + rollup 统计。确认/拒绝/指派/新建后统一
 * 经 refreshAll() 重新拉取列表与当前选中项的明细, 保证计数不漂移。
 */

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<ProjectMembership[]>([]);
  const [rollup, setRollup] = useState<ProjectRollupResp | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const refreshProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    setLoading(true);
    setError(null);
    try {
      const list = await listProjects();
      setProjects(list);
      // 选中项被删/不可见时退回首项; 否则保持当前选择。
      setSelectedCode((prev) =>
        prev && list.some((p) => p.code === prev) ? prev : (list[0]?.code ?? null));
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : '项目列表加载失败');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  /** 拉取选中项目的归属 + rollup(项目切换与写操作后共用)。 */
  const refreshDetail = useCallback(async (code: string | null) => {
    if (!code) {
      setMemberships([]);
      setRollup(null);
      return;
    }
    setDetailLoading(true);
    try {
      const [ms, r] = await Promise.all([
        listMemberships(code),
        fetchProjectRollup(code),
      ]);
      setMemberships(ms);
      setRollup(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : '项目明细加载失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDetail(selectedCode);
  }, [selectedCode, refreshDetail]);

  /** 写操作后的统一刷新: 列表(计数) + 当前选中明细。 */
  const refreshAll = useCallback(async () => {
    await refreshProjects();
    await refreshDetail(selectedCode);
  }, [refreshProjects, refreshDetail, selectedCode]);

  const addProject = useCallback(
    async (code: string, name: string) => {
      await createProject(code, name);
      await refreshProjects();
    },
    [refreshProjects],
  );

  const assign = useCallback(
    async (code: string, contractNo: string, role: string) => {
      await assignMembership(code, { contractNo, role });
      await refreshAll();
    },
    [refreshAll],
  );

  const confirm = useCallback(
    async (id: string) => {
      await confirmMembership(id);
      await refreshAll();
    },
    [refreshAll],
  );

  const reject = useCallback(
    async (id: string) => {
      await rejectMembership(id);
      await refreshAll();
    },
    [refreshAll],
  );

  return {
    projects,
    loading,
    error,
    selectedCode,
    selectProject: setSelectedCode,
    memberships,
    rollup,
    detailLoading,
    refreshAll,
    addProject,
    assign,
    confirm,
    reject,
  };
}

export type ProjectsApi = ReturnType<typeof useProjects>;
