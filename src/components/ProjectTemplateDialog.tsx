import React, { useState } from 'react'
import { X, FileText, Calculator, ShieldCheck, Truck, ShoppingCart, CheckCircle2 } from 'lucide-react'
import { type ProjectTemplate, PROJECT_TEMPLATES } from '../data/mock'
import { Button } from './ui/Card'
import clsx from 'clsx'

interface ProjectTemplateDialogProps {
  open: boolean
  onClose: () => void
  onCreate: (template: ProjectTemplate) => void
}

const TEMPLATE_ICONS: Record<string, typeof FileText> = {
  file: FileText,
  calculator: Calculator,
  shield: ShieldCheck,
  truck: Truck,
  cart: ShoppingCart,
}

export const ProjectTemplateDialog: React.FC<ProjectTemplateDialogProps> = ({ open, onClose, onCreate }) => {
  const [selected, setSelected] = useState<string | null>(null)
  const selectedTemplate = PROJECT_TEMPLATES.find((t) => t.id === selected)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-fade-in">
      <div className="bg-white rounded-xl shadow-2xl w-[720px] max-w-[90vw] max-h-[90vh] overflow-hidden flex flex-col">
        <div className="h-14 px-4 border-b border-borderGray flex items-center justify-between bg-bgGray">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-deepSea/10 flex items-center justify-center">
              <FileText className="w-4 h-4 text-deepSea" />
            </div>
            <div>
              <div className="text-sm font-medium text-textDark">新建项目</div>
              <div className="text-xs text-textGray">选择业务模板，自动预填阶段、专家与连接器</div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-borderGray text-textGray">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {PROJECT_TEMPLATES.map((template) => {
              const Icon = TEMPLATE_ICONS[template.icon] || FileText
              const isActive = selected === template.id
              return (
                <button
                  key={template.id}
                  onClick={() => setSelected(template.id)}
                  className={clsx(
                    'text-left rounded-xl border p-4 transition-all hover:shadow-md',
                    isActive
                      ? 'border-deepSea bg-deepSea/5 ring-1 ring-deepSea/20'
                      : 'border-borderGray bg-white hover:border-steelBlue/50'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className={clsx(
                      'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                      isActive ? 'bg-deepSea text-white' : 'bg-bgGray text-steelBlue'
                    )}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-textDark">{template.name}</span>
                        {isActive && <CheckCircle2 className="w-4 h-4 text-deepSea" />}
                      </div>
                      <p className="text-xs text-textGray mt-1 leading-relaxed">{template.description}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {template.stages.slice(0, 4).map((stage) => (
                          <span key={stage} className="text-[10px] px-1.5 py-0.5 rounded bg-bgGray text-textGray border border-borderGray">
                            {stage}
                          </span>
                        ))}
                        {template.stages.length > 4 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bgGray text-textGray border border-borderGray">
                            +{template.stages.length - 4}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {selectedTemplate && (
            <div className="mt-5 rounded-xl border border-borderGray bg-bgGray/50 p-4 animate-fade-in">
              <div className="text-xs font-medium text-textGray mb-2 uppercase tracking-wider">模板预填配置</div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-textGray mb-1">指令护栏</div>
                  <div className="text-textDark leading-relaxed">{selectedTemplate.instructions}</div>
                </div>
                <div>
                  <div className="text-xs text-textGray mb-1">专家</div>
                  <div className="space-y-1">
                    {selectedTemplate.experts.map((e) => (
                      <div key={e.name} className="flex items-start gap-2">
                        <span className="text-xs px-1.5 py-0.5 rounded bg-steelBlue/10 text-steelBlue font-medium">{e.name}</span>
                        <span className="text-xs text-textGray">{e.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-textGray mb-1">连接器</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedTemplate.connectors.map((c) => (
                      <span key={c.name} className={clsx(
                        'text-xs px-1.5 py-0.5 rounded border',
                        c.authType === 'public'
                          ? 'bg-success/10 text-success border-success/20'
                          : 'bg-steelBlue/10 text-steelBlue border-steelBlue/20'
                      )}>
                        {c.name} · {c.authType === 'public' ? '公共授权' : '个人授权'}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-textGray mb-1">能力 / SOP</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedTemplate.skills.map((s) => (
                      <span key={s.name} className="text-xs px-1.5 py-0.5 rounded bg-amber/10 text-amber border border-amber/20">
                        {s.name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-borderGray bg-bgGray flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!selectedTemplate}
            onClick={() => selectedTemplate && onCreate(selectedTemplate)}
          >
            创建项目
          </Button>
        </div>
      </div>
    </div>
  )
}
