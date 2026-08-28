import { useEffect, useRef } from 'react'
import type { TextareaHTMLAttributes } from 'react'
import clsx from 'clsx'

interface AutoGrowTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  maxHeight?: number
}

export default function AutoGrowTextarea({ maxHeight = 200, className, ...rest }: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  })

  return (
    <textarea
      ref={ref}
      className={clsx('resize-none', className)}
      style={{ maxHeight }}
      {...rest}
    />
  )
}
