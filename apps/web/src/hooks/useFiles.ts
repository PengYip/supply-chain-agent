import { useState, useEffect, useCallback } from 'react';

export interface FileEntry {
  key: string;
  name: string;        // extracted filename
  size: number;
  lastModified: string;
  docId?: string;      // document ID from backend
  directory: string;   // directory path (e.g. "/" or "/合同文件")
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
};

type RawFolder = {
  id?: unknown;
  path?: unknown;
};

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
  };
}

function normalizeFolder(raw: RawFolder): FileFolder {
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    path: typeof raw.path === 'string' ? raw.path : '',
  };
}

export function useFiles() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [folders, setFolders] = useState<FileFolder[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/files');
      if (res.ok) {
        const data = (await res.json()) as RawFile[] | { files?: RawFile[]; folders?: RawFolder[] };
        const rawFiles: RawFile[] = Array.isArray(data) ? data : data.files ?? [];
        const rawFolders: RawFolder[] = Array.isArray(data) ? [] : data.folders ?? [];
        setFiles(rawFiles.map(normalizeFile));
        setFolders(rawFolders.map(normalizeFolder));
      }
    } catch { /* ignore */ }
    setLoading(false);
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

  const deleteFile = useCallback(async (key: string) => {
    const res = await fetch(`/api/files/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) throw new Error('delete failed');
    await refresh();
  }, [refresh]);

  return { files, folders, loading, refresh, downloadFile, moveFile, createFolder, removeFolder, deleteFile };
}
