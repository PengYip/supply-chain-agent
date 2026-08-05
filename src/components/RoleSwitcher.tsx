import React, { useState, useRef, useEffect } from 'react'
import { Shield, ChevronDown, Check } from 'lucide-react'
import { ROLE_LABELS, ROLE_DOMAINS, type Role } from '../data/mock'
import clsx from 'clsx'

interface RoleSwitcherProps {
  currentRole: Role
  onRoleChange: (role: Role) => void
  variant?: 'dark' | 'light'
}

const ROLES: Role[] = ['trader', 'risk', 'finance', 'management']

export const RoleSwitcher: React.FC<RoleSwitcherProps> = ({ currentRole, onRoleChange, variant = 'dark' }) => {
  const isLight = variant === 'light'
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-sm transition-all',
          open
            ? 'bg-white border-steelBlue/30 shadow-sm'
            : isLight
            ? 'bg-bgGray border-borderGray hover:bg-white'
            : 'bg-white/50 border-white/10 hover:bg-white/80'
        )}
      >
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-amber" />
          <span className={clsx('font-medium', isLight ? 'text-textDark' : 'text-white')}>{ROLE_LABELS[currentRole]}</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 transition-transform', isLight ? 'text-textGray' : 'text-white/70', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-2 bg-white rounded-lg shadow-xl border border-borderGray overflow-hidden z-50 animate-fade-in">
          <div className="px-3 py-2 text-xs text-textGray border-b border-borderGray bg-bgGray">
            切换角色以改变可见能力域
          </div>
          {ROLES.map((role) => (
            <button
              key={role}
              onClick={() => {
                onRoleChange(role)
                setOpen(false)
              }}
              className={clsx(
                'w-full text-left px-3 py-2.5 text-sm hover:bg-bgGray transition-colors flex items-start gap-2',
                currentRole === role ? 'bg-amber/5' : ''
              )}
            >
              <div className={clsx(
                'w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5',
                currentRole === role ? 'bg-deepSea text-white' : 'bg-borderGray text-textGray'
              )}>
                {currentRole === role ? <Check className="w-3 h-3" /> : <span className="text-[10px] font-bold">{ROLE_LABELS[role][0]}</span>}
              </div>
              <div className="flex-1 min-w-0">
                <div className={clsx('font-medium', currentRole === role ? 'text-deepSea' : 'text-textDark')}>
                  {ROLE_LABELS[role]}
                </div>
                <div className="text-xs text-textGray mt-0.5 line-clamp-1">
                  {ROLE_DOMAINS[role].join(' · ')}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
