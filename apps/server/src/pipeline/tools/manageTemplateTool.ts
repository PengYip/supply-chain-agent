// manage_template — L2 Agent 工具(P4 spec §5): templateManage 统一写入面的
// 工具分派薄层。工具不含独立 SQL——全部转调 createTemplateType /
// updateTemplateTypeProps / updateEdgeRuleVocab / setTemplateTypeActive /
// setEdgeRuleActive, 与 /api/templates 管理 REST(ConfirmationSource=human 通道)
// 共享同一业务规则与版本审计。
//
// 注册: roleToolRegistry 挂 needsApproval: true(v6 软门控, 人对 AI 同一校验通道)。
// 错误处理: execute 返回结构化 {status:'error', reason, code} 不抛异常
// (templateOverviewTool / link_amends 同例), zod schema 先挡一层形状,
// 跨 action 的必填参数组合在 execute 内 switch 兜第二层(直调不经框架校验)。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../db/client.js';
import {
  createTemplateType, updateTemplateTypeProps, updateEdgeRuleVocab,
  setEdgeRuleActive, setTemplateTypeActive,
} from '../templateManage.js';

export interface ManageTemplateToolDeps {
  ctx: DbContext;
  userId?: string;
}

type ToolError = { status: 'error'; reason: string; code: 'not_found' | 'duplicate' | 'protected' | 'invalid' };

const fail = (reason: string, code: ToolError['code']): ToolError => ({ status: 'error', reason, code });

export function buildManageTemplateTool(deps: ManageTemplateToolDeps) {
  return tool({
    description:
      '维护业务图谱模板层(类型登记/属性与词表维护/软禁用激活)。什么时候用: 用户说' +
      '"新增一类XX单据""收货单要加个必填字段""这条边规则的词表改一下""先把XX类型停用/重新启用"时调用。' +
      'L2 操作: 调用需附带人工授权(needsApproval)。边界: 不做物理删除(spec §5 删除保护, ' +
      '只有软禁用); 不改已落图边的版本(存量图投影不回溯); 类型-合同组合兼容性由绑定时的' +
      'templateGate 把关而非此处。参数: action=create_type 需 kind+name; update_props 需 ' +
      'typeId(dt-/ct- 前缀 id, 可先调 template_overview 查名取 id); update_vocab 需 ruleId+' +
      'allowedVocab; set_rule_active 需 ruleId+active; set_type_active 用 typeName(中文名)。',
    inputSchema: z.object({
      action: z.enum(['create_type', 'update_props', 'update_vocab', 'set_type_active', 'set_rule_active'])
        .describe('create_type=新增类型; update_props=改类型属性(抽取提示/绑定目标); update_vocab=改边规则词表; set_type_active=set_rule_active=软禁用/激活'),
      // create_type
      kind: z.enum(['doc_type', 'contract_type']).optional(),
      name: z.string().min(1).max(50).optional(),
      parentIdName: z.string().optional().describe('父类型名, 如 收货单 的父 运输凭证'),
      props: z.record(z.string(), z.unknown()).optional().describe('如 {requiredFields:[..], fieldHints:{..}, bindingsTargetKind:"Contract"|"Project"}'),
      typeId: z.string().optional(),          // update_props / set_rule_active 前者的目标(dt-/ct- 前缀 id)
      ruleId: z.string().optional(),          // update_vocab / set_rule_active 目标(er- 前缀)
      typeName: z.string().max(50).optional().describe('set_type_active 目标(类型中文名, 如 发货单)'),
      allowedVocab: z.array(z.string()).optional(),
      active: z.boolean().optional(),
    }),
    execute: async (input) => {
      const actor = deps.userId ?? 'agent';
      try {
        switch (input.action) {
          case 'create_type': {
            if (!input.kind || !input.name?.trim()) {
              return fail('create_type 需要 kind(doc_type|contract_type) 与 name', 'invalid');
            }
            const r = await createTemplateType(deps.ctx, actor, {
              kind: input.kind, name: input.name,
              parentIdName: input.parentIdName, props: input.props,
            });
            return r.ok
              ? { status: 'ok' as const, action: input.action, templateVersion: r.templateVersion, ...r.data }
              : fail(r.reason, r.code);
          }
          case 'update_props': {
            if (!input.typeId || (input.props === undefined && input.parentIdName === undefined)) {
              return fail('update_props 需要 typeId(dt-/ct- 前缀) 且至少给 props 或 parentIdName 其一', 'invalid');
            }
            const r = await updateTemplateTypeProps(deps.ctx, actor, {
              typeId: input.typeId, parentIdName: input.parentIdName ?? undefined, props: input.props,
            });
            return r.ok
              ? { status: 'ok' as const, action: input.action, templateVersion: r.templateVersion, ...r.data }
              : fail(r.reason, r.code);
          }
          case 'update_vocab': {
            if (!input.ruleId || !Array.isArray(input.allowedVocab)) {
              return fail('update_vocab 需要 ruleId(er- 前缀) 与 allowedVocab(字符串数组)', 'invalid');
            }
            const r = await updateEdgeRuleVocab(deps.ctx, actor, {
              ruleId: input.ruleId, allowedVocab: input.allowedVocab,
            });
            return r.ok
              ? { status: 'ok' as const, action: input.action, templateVersion: r.templateVersion, ...r.data }
              : fail(r.reason, r.code);
          }
          case 'set_type_active': {
            if (!input.typeName?.trim() || typeof input.active !== 'boolean') {
              return fail('set_type_active 需要 typeName(类型中文名) 与 active(true|false)', 'invalid');
            }
            const r = await setTemplateTypeActive(deps.ctx, actor, {
              typeName: input.typeName, active: input.active,
            });
            return r.ok
              ? {
                  status: 'ok' as const, action: input.action, templateVersion: r.templateVersion, ...r.data,
                }
              : fail(r.reason, r.code);
          }
          case 'set_rule_active': {
            if (!input.ruleId || typeof input.active !== 'boolean') {
              return fail('set_rule_active 需要 ruleId(er- 前缀) 与 active(true|false)', 'invalid');
            }
            const r = await setEdgeRuleActive(deps.ctx, actor, {
              ruleId: input.ruleId, active: input.active,
            });
            return r.ok
              ? { status: 'ok' as const, action: input.action, templateVersion: r.templateVersion, ...r.data }
              : fail(r.reason, r.code);
          }
        }
      } catch (e) {
        // 兜底: 意外异常也以结构化错误返回, 不打断 agent 主流程。
        return fail(`manage_template 执行失败: ${e instanceof Error ? e.message : String(e)}`, 'invalid');
      }
    },
  });
}
