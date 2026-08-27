// 文件树纯逻辑（树构建/路径解析），与组件分离以便复用并保持组件文件
// 仅导出组件（fast-refresh 友好）。
import { type FileEntry, type FileFolder } from '../hooks/useFiles';

export interface TreeNode {
  files: FileEntry[];
  subdirs: Record<string, TreeNode>;
}

export function pathSegments(p: string | undefined): string[] {
  if (!p) return [];
  return p.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function buildTree(files: FileEntry[], folders: FileFolder[]): TreeNode {
  const root: TreeNode = { files: [], subdirs: {} };
  const getOrCreate = (segs: string[]): TreeNode => {
    let node = root;
    for (const seg of segs) {
      if (!node.subdirs[seg]) node.subdirs[seg] = { files: [], subdirs: {} };
      node = node.subdirs[seg];
    }
    return node;
  };
  for (const folder of folders) getOrCreate(pathSegments(folder.path));
  for (const file of files) getOrCreate(pathSegments(file.directory)).files.push(file);
  return root;
}

export function normalizeMoveDirectory(directory: string): string {
  return directory
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('/');
}
