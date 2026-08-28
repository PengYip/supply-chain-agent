// load_skill(L1 只读, 2026-08-28 Skill 化): 按登记名返回技能文档全文。
// 全文作为工具结果持久进入对话(同会话后续轮次可见, 被压缩后可重新加载)。
// 边界: 只接受系统提示词"可用技能"清单中的名字; 返回的是操作指导文本,
// 本身不执行任何计算或写操作, 数字必须另行来自业务工具返回的数据。
import { tool } from 'ai';
import { z } from 'zod';
import { loadSkillByName, discoverSkills } from '../harness/skillDiscovery.js';

export function buildLoadSkillTool() {
  return tool({
    description:
      '按技能名加载业务流程技能的完整文档。什么时候用: 系统提示词"可用技能"清单中列出的场景出现时' +
      '(如货值暂估/结算计算), 必须先调用本工具加载技能全文、严格按技能流程执行; ' +
      '用户询问"你有什么技能"时也用它取全文转述。' +
      '边界: name 只接受技能清单中登记的名字(如 settlement-valuation), 未登记返回 success:false 与可用名单; ' +
      '返回内容是操作指导文本, 不执行任何计算或写操作; 计算依据必须另行来自业务工具返回的数据。' +
      '返回: { success, name, description, content } 或 { success: false, error }。',
    inputSchema: z.object({
      name: z.string().min(1).describe('技能名, 与系统提示词"可用技能"清单一致, 如 settlement-valuation'),
    }),
    execute: async ({ name }) => {
      const skill = await loadSkillByName(name);
      if (!skill) {
        const known = discoverSkills().map((s) => s.name).join(', ');
        return { success: false as const, error: `未登记的技能名: ${name}（可用: ${known || '无'}）` };
      }
      return { success: true as const, name: skill.name, description: skill.description, content: skill.content };
    },
  });
}
