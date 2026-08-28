// load_skill(L1 只读, 2026-08-28 Skill 化): 按登记名返回技能文档全文;
// file 参数可读技能目录内附属文件(references 契约)。
// 全文作为工具结果持久进入对话(同会话后续轮次可见, 被压缩后可重新加载)。
// 边界: 只接受系统提示词"可用技能"清单中的名字; file 只接受加载技能时返回的
// files 清单里的相对路径(../绝对路径/盘符一律拒绝, 双重防逃逸); 返回的是操作
// 指导文本, 本身不执行任何计算或写操作, 数字必须另行来自业务工具返回的数据。
import { tool } from 'ai';
import { z } from 'zod';
import {
  loadSkillByName, loadSkillFileByName, listSkillFiles, discoverSkills,
} from '../harness/skillDiscovery.js';

export function buildLoadSkillTool() {
  return tool({
    description:
      '按技能名加载业务流程技能的完整文档; file 参数可进一步读取该技能的附属参考文件。' +
      '什么时候用: 系统提示词"可用技能"清单中列出的场景出现时(如货值暂估/结算计算), 必须先调用本工具' +
      '加载技能全文、严格按技能流程执行; 技能正文指向 references/ 等附属文件时, 用 file 参数读取; ' +
      '用户询问"你有什么技能"时也用它取全文转述。' +
      '边界: name 只接受技能清单中登记的名字(如 settlement-valuation), 未登记返回 success:false 与可用名单; ' +
      'file 只接受不带 file 调用时返回的 files 清单中的相对路径, 含 ../、绝对路径、盘符或不在清单内的路径' +
      '一律返回 success:false(防逃逸); 超长参考文件会显式截断并标注。' +
      '返回: 不带 file -> { success, name, description, content, files[] }; ' +
      '带 file -> { success, name, file, content, truncated? }; 失败 -> { success: false, error }。',
    inputSchema: z.object({
      name: z.string().min(1).describe('技能名, 与系统提示词"可用技能"清单一致, 如 settlement-valuation'),
      file: z
        .string()
        .min(1)
        .optional()
        .describe('技能内附属文件相对路径, 如 references/report-template.md; 必须来自不带 file 调用时返回的 files 清单'),
    }),
    execute: async ({ name, file }) => {
      if (file !== undefined) {
        const ref = await loadSkillFileByName(name, file);
        if (!ref) {
          const files = await listSkillFiles(name);
          return {
            success: false as const,
            error:
              `无法读取 ${name} 的附属文件 "${file}"（不存在、不在 files 清单内或路径含 ../ 等逃逸片段）。` +
              `可用文件: ${files.length > 0 ? files.join(', ') : '无'}`,
          };
        }
        return { success: true as const, name, file: ref.path, content: ref.content, truncated: ref.truncated };
      }
      const skill = await loadSkillByName(name);
      if (!skill) {
        const known = discoverSkills().map((s) => s.name).join(', ');
        return { success: false as const, error: `未登记的技能名: ${name}（可用: ${known || '无'}）` };
      }
      const files = await listSkillFiles(name);
      return {
        success: true as const,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        files,
      };
    },
  });
}
