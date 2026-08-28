// Skill 发现层(tool-inventory 方法论第4步 Skill 化, 2026-08-28)。
// skills 是部署内置的 apps/server/skills/<名>/SKILL.md(YAML frontmatter:
// name/description/whenToUse 单行值, 不支持多行 YAML -- 边界如实声明)。
// 启动时同步扫描一次并缓存; 索引段拼进 SYSTEM_PROMPT 静态尾部(KV cache 稳定);
// 全文经 load_skill 工具按需加载(工具结果持久进入对话)。参考 fastchain-agent-demo
// 的 discovery/load 两段式, 按本仓库准则适配: name 参数(不暴露任意路径)。
// 失败语义: 目录不存在/扫描失败/坏 frontmatter 一律"跳过或空", 不阻塞启动。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

export const SkillMetadata = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  whenToUse: z.string().min(1),
});
export type SkillMetadataShape = z.infer<typeof SkillMetadata>;

export interface SkillMeta extends SkillMetadataShape { path: string }
export interface SkillDefinition extends SkillMeta { content: string }

export function skillsRoot(): string {
  return fileURLToPath(new URL('../../skills/', import.meta.url));
}

interface Entry extends SkillMetadataShape { absDir: string }

let cache: Entry[] | null = null;

export function resetSkillCache(): void {
  cache = null;
}

/** 解析 `---\n...yaml...\n---\n` 头; 缺失/损坏返回 null。 */
function parseFrontmatter(raw: string): { meta: unknown; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  try {
    return { meta: parse(m[1]!), body: (m[2] ?? '').trim() };
  } catch {
    return null;
  }
}

function toMeta(e: Entry): SkillMeta {
  return { name: e.name, description: e.description, whenToUse: e.whenToUse, path: `skills/${e.name}/SKILL.md` };
}

/** 同步扫描 root(测试注入临时目录用); 目录不存在返回空数组, 不抛错。 */
export function discoverSkillsFrom(root: string): SkillMeta[] {
  return scanSync(root).map(toMeta);
}

/** 默认目录扫描(带缓存); 启动时由 agent.ts 调用一次。 */
export function discoverSkills(): SkillMeta[] {
  if (!cache) cache = scanSync(skillsRoot());
  return cache.map(toMeta);
}

export function loadSkillFrom(name: string, root: string): SkillDefinition | null {
  const entry = scanSync(root).find((e) => e.name === name);
  if (!entry) return null;
  return readEntry(entry);
}

/** 按登记名加载全文(未登记 -> null)。load_skill 工具的 execute 走这里。 */
export async function loadSkillByName(name: string): Promise<SkillDefinition | null> {
  if (!cache) cache = scanSync(skillsRoot());
  const entry = cache.find((e) => e.name === name);
  if (!entry) return null;
  return readEntry(entry);
}

function scanSync(root: string): Entry[] {
  let dirNames: string[];
  try {
    if (!existsSync(root)) return [];
    dirNames = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
  } catch {
    return [];
  }
  const found: Entry[] = [];
  for (const dirName of dirNames) {
    const absDir = join(root, dirName);
    let raw: string;
    try {
      raw = readFileSync(join(absDir, 'SKILL.md'), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      console.warn(`[skillDiscovery] SKILL.md frontmatter 缺失或损坏, 跳过: ${absDir}`);
      continue;
    }
    const result = SkillMetadata.safeParse(parsed.meta);
    if (!result.success) {
      console.warn(`[skillDiscovery] SKILL.md frontmatter 缺 name/description/whenToUse, 跳过: ${absDir}`);
      continue;
    }
    if (result.data.name !== dirName) {
      console.warn(`[skillDiscovery] frontmatter name(${result.data.name}) 与目录名(${dirName})不一致, 跳过: ${absDir}`);
      continue;
    }
    found.push({ ...result.data, absDir });
  }
  return found;
}

function readEntry(entry: Entry): SkillDefinition | null {
  let raw: string;
  try {
    raw = readFileSync(join(entry.absDir, 'SKILL.md'), 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  return {
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse,
    path: `skills/${entry.name}/SKILL.md`,
    content: parsed.body,
  };
}

/** 生成 SYSTEM_PROMPT 尾部的技能索引段; 无技能返回空串。 */
export function buildSkillIndexSection(skills: SkillMeta[]): string {
  if (skills.length === 0) return '';
  const list = skills
    .map((s) => `- ${s.name}: ${s.description}（何时用: ${s.whenToUse}）`)
    .join('\n');
  return [
    '',
    '## 可用技能（Skills, 业务流程知识按需加载）',
    '系统为以下业务流程内置了标准作业技能, 命中适用场景时必须先加载技能全文再执行:',
    list,
    '技能使用规则:',
    '1. 用户问题命中某个技能的"何时用"时, 必须先调用 load_skill 加载技能全文, 严格按技能流程执行, 不得凭记忆跳步。',
    '2. 用户询问"你有什么技能/有哪些标准流程"时, 如实列举上述技能名单与用途。',
    '3. 技能内容是操作指导, 不替代业务工具: 一切数字仍须来自 query_business/recall_documents/gather_settlement_evidence 等工具返回的数据, 技能不改变数字零幻觉硬约束。',
    '4. 技能内容随对话持久有效; 若历史被压缩后看不到内容, 重新调用 load_skill 即可。',
  ].join('\n');
}
