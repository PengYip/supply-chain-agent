import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 聊天消息正文的 Markdown 渲染（react-markdown + remark-gfm，语义 token 配色）。
 *  2026-08-31 从 RealMessageItem 原样抽取为共享组件：主聊天消息气泡、
 *  SkillCard 全文与只读分享页共用同一实现，保证各处观感一致；
 *  组件体与抽取前的 RealMessageItem 内联版本逐字相同。 */

export const MarkdownContent: React.FC<{ children: string }> = ({ children }) => {
  return (
    <div className="text-sm leading-relaxed text-ink markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-bold text-ink">{children}</strong>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-')
            if (isBlock) {
              return (
                <pre className="bg-surface rounded p-2 overflow-auto mb-2">
                  <code className="font-mono text-xs text-ink bg-transparent">{children}</code>
                </pre>
              )
            }
            return <code className="font-mono text-xs bg-surface px-1 py-0.5 rounded text-ink">{children}</code>
          },
          table: ({ children }) => <table className="w-full text-xs border-collapse border border-line mb-2">{children}</table>,
          thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
          th: ({ children }) => <th className="border border-line px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
          a: ({ children, href }) => <a href={href} className="text-primary hover:underline">{children}</a>,
          hr: () => <hr className="my-3 border-line" />,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-primary-500 pl-3 italic text-ink-soft mb-2">{children}</blockquote>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
