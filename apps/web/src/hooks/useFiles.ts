import { useState, useEffect, useCallback } from 'react';

/** Server-side parse state for a stored file, as reported by GET /api/files.
 *  `null` means the backend has no parse record for the object yet. */
export type FileParseStatus =
  | 'uploaded'
  | 'parsing'
  | 'parsed'
  | 'needs_ocr'
  | 'failed';

/** 解析进行中的细分阶段（parseStage；后端未部署阶段字段/无阶段为 null，
 *  解析落终态时后端清为 null）。 */
export type FileParseStage =
  | 'detecting'
  | 'ocr'
  | 'extracting'
  | 'indexing';

export interface FileEntry {
  key: string;
  name: string;        // extracted filename
  size: number;
  lastModified: string;
  docId?: string;      // document ID from backend
  directory: string;   // directory path (e.g. "/" or "/合同文件")
  parseStatus: FileParseStatus | null;
  /** 已解析出的具体业务类型；解析未完成、失败或兜底其他时为 null。 */
  businessType?: string | null;
  /** 解析阶段（仅解析进行中有意义；null = 后端未部署阶段字段/无阶段）。 */
  parseStage?: FileParseStage | null;
  /** 当前阶段的起始时间（ISO，后端随阶段推进重置）；null = 未知。 */
  stageStartedAt?: string | null;
  /* Optional because synthetic FileEntry literals elsewhere (e.g. the preview
   * trace in ContractExecutionSection) don't carry it; undefined reads as not bound. */
  bound?: boolean;     // true once the file is bound to a contract ledger row
  /** 批量拆分角色： 'container' = 单据组（一个物理文件拆成多份子单据，行内
   *  可展开子单据层级）；null/undefined = 普通文件（unit 子单据不占文件条目）。 */
  batchRole?: 'container' | null;
  /** container 的子单据数（GET /api/files 提供）；非 container 恒 null。 */
  unitCount?: number | null;
}

export interface FileFolder {
  id: string;
  path: string;        // e.g. "合同文件" or "合同文件/上游"
}

export interface ContextFile {
  docId: string;
  filename: string;
  key: string;
}

type RawFile = {
  key?: unknown;
  name?: unknown;
  size?: unknown;
  lastModified?: unknown;
  docId?: unknown;
  directory?: unknown;
  parseStatus?: unknown;
  businessType?: unknown;
  parseStage?: unknown;
  stageStartedAt?: unknown;
  bound?: unknown;
  batchRole?: unknown;
  unitCount?: unknown;
};

type RawFolder = {
  id?: unknown;
  path?: unknown;
};

const FILE_PARSE_STATUSES: readonly string[] = [
  'uploaded',
  'parsing',
  'parsed',
  'needs_ocr',
  'failed',
];

const FILE_PARSE_STAGES: readonly string[] = [
  'detecting',
  'ocr',
  'extracting',
  'indexing',
];

function normalizeFile(raw: RawFile): FileEntry {
  const key = typeof raw.key === 'string' ? raw.key : '';
  const name =
    typeof raw.name === 'string' && raw.name.length > 0
      ? raw.name
      : key.split('/').pop() || key;
  let directory = typeof raw.directory === 'string' ? raw.directory : '';
  if (!directory) {
    const idx = key.lastIndexOf('/');
    directory = idx >= 0 ? key.slice(0, idx) : '/';
    if (directory === '') directory = '/';
  }
  const size =
    typeof raw.size === 'number'
      ? raw.size
      : typeof raw.size === 'string'
        ? Number(raw.size) || 0
        : 0;
  return {
    key,
    name,
    size,
    lastModified: typeof raw.lastModified === 'string' ? raw.lastModified : '',
    docId: typeof raw.docId === 'string' ? raw.docId : undefined,
    directory,
    parseStatus:
      typeof raw.parseStatus === 'string' && FILE_PARSE_STATUSES.includes(raw.parseStatus)
        ? (raw.parseStatus as FileParseStatus)
        : null,
    // 阶段字段同样白名单归一: 未知/缺失一律 null, 保证前端可先于后端部署
    // (null 走旧「解析中」文案, 行为零变化)。
    parseStage:
      typeof raw.parseStage === 'string' && FILE_PARSE_STAGES.includes(raw.parseStage)
        ? (raw.parseStage as FileParseStage)
        : null,
    stageStartedAt:
      typeof raw.stageStartedAt === 'string' && raw.stageStartedAt
        ? raw.stageStartedAt
        : null,
    businessType:
      typeof raw.businessType === 'string' && raw.businessType.trim().length > 0
        ? raw.businessType.trim()
        : null,
    bound: raw.bound === true,
    // 单据组(container)谱系字段: 仅认 'container' 白名单值,其余一律 null
    // (unitCount 只在 container 上有意义,后端对非 container 恒 null)。
    batchRole: raw.batchRole === 'container' ? 'container' : null,
    unitCount:
      raw.batchRole === 'container' && typeof raw.unitCount === 'number'
        ? raw.unitCount
        : null,
  };
}

function normalizeFolder(raw: RawFolder): FileFolder {
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    path: typeof raw.path === 'string' ? raw.path : '',
  };
}

/** Fetch the raw bytes of a stored file as a Blob (session-cookie
 *  authenticated). Throws on non-2xx so callers can surface a retry state. */
export async function fetchFileBlob(key: string): Promise<Blob> {
  const res = await fetch(`/api/files/stream?key=${encodeURIComponent(key)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export function useFiles() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [folders, setFolders] = useState<FileFolder[]>([]);
  const [loading, setLoading] = useState(true);

  /** 拉取文件列表并整表替换(keys 稳定, 行实例/选中/展开状态不受影响)。
   *  返回本次拉到的最新列表供调用方立即判定(如进度轮询的 in-flight 计算);
   *  请求失败或非 2xx 返回 null, 调用方保留旧状态自行兜底。 */
  const refresh = useCallback(async (): Promise<FileEntry[] | null> => {
    let next: FileEntry[] | null = null;
    try {
      const res = await fetch('/api/files');
      if (res.ok) {
        const data = (await res.json()) as RawFile[] | { files?: RawFile[]; folders?: RawFolder[] };
        const rawFiles: RawFile[] = Array.isArray(data) ? data : data.files ?? [];
        const rawFolders: RawFolder[] = Array.isArray(data) ? [] : data.folders ?? [];
        next = rawFiles.map(normalizeFile);
        setFiles(next);
        setFolders(rawFolders.map(normalizeFolder));
      }
    } catch { /* ignore */ }
    setLoading(false);
    return next;
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const downloadFile = useCallback(async (key: string) => {
    try {
      const res = await fetch(`/api/files/presign?key=${encodeURIComponent(key)}`);
      if (res.ok) {
        const { url } = await res.json();
        window.open(url, '_blank');
      }
    } catch { /* ignore */ }
  }, []);

  const moveFile = useCallback(async (key: string, directory: string) => {
    await fetch('/api/files/move', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, directory }),
      credentials: 'include',
    });
    await refresh();
  }, [refresh]);

  const createFolder = useCallback(async (path: string) => {
    await fetch('/api/files/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      credentials: 'include',
    });
    await refresh();
  }, [refresh]);

  const removeFolder = useCallback(async (path: string) => {
    await fetch(`/api/files/rmdir?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    await refresh();
  }, [refresh]);

  /** 文件夹整体改名/移动（含子树与其中对象），走 PATCH /folder-path。 */
  const renameFolderPath = useCallback(async (from: string, to: string) => {
    const res = await fetch('/api/files/folder-path', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
      credentials: 'include',
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(j?.error || `folder-path failed (${res.status})`);
    }
    await refresh();
  }, [refresh]);

  const deleteFile = useCallback(async (key: string) => {
    const res = await fetch(`/api/files/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) throw new Error('delete failed');
    await refresh();
  }, [refresh]);

  /** 拖拽排序：文件夹全组顺序（完整路径数组，索引即 rank）。 */
  const reorderFolders = useCallback(async (paths: string[]) => {
    const res = await fetch('/api/files/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'folders', paths }),
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`reorder failed (${res.status})`);
    await refresh();
  }, [refresh]);

  /** 拖拽排序：文件全组顺序（MinIO key 数组，索引即 rank）。 */
  const reorderFiles = useCallback(async (keys: string[]) => {
    const res = await fetch('/api/files/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'files', keys }),
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`reorder failed (${res.status})`);
    await refresh();
  }, [refresh]);

  return { files, folders, loading, refresh, downloadFile, moveFile, createFolder, removeFolder, renameFolderPath, reorderFolders, reorderFiles, deleteFile };
}

/** The full useFiles() return value, so App can own one instance and hand it
 *  to the file drawer as a single prop (files live above the drawer now). */
export type FilesApi = ReturnType<typeof useFiles>;
