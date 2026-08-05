import React from 'react'
import clsx from 'clsx'

interface CardProps {
  children: React.ReactNode
  className?: string
  title?: string | React.ReactNode
  extra?: React.ReactNode
}

export const Card: React.FC<CardProps> = ({ children, className, title, extra }) => {
  return (
    <div className={clsx('bg-card rounded-lg shadow-card p-3 flex flex-col', className)}>
      {(title || extra) && (
        <div className="flex items-center justify-between mb-3">
          {title && <h3 className="text-base font-bold text-textDark">{title}</h3>}
          {extra}
        </div>
      )}
      {children}
    </div>
  )
}

export const StatusTag: React.FC<{ status: string; className?: string }> = ({ status, className }) => {
  const map: Record<string, string> = {
    '已发货': 'bg-success/10 text-success',
    '已完成': 'bg-success/10 text-success',
    '待付款': 'bg-warning/10 text-warning',
    '待发货': 'bg-steelBlue/10 text-steelBlue',
  }
  return (
    <span className={clsx('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium', map[status] || 'bg-borderGray text-textGray', className)}>
      {status}
    </span>
  )
}

export const RiskTag: React.FC<{ level: '高' | '中' | '低' | string }> = ({ level }) => {
  const map = {
    '高': 'bg-danger/10 text-danger',
    '中': 'bg-warning/10 text-warning',
    '低': 'bg-success/10 text-success',
  }
  return (
    <span className={clsx('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium', map[level as '高' | '中' | '低'])}>
      {level}
    </span>
  )
}

export const ConfidenceDot: React.FC<{ level: 'high' | 'medium' | 'low' }> = ({ level }) => {
  const map = {
    high: 'bg-success',
    medium: 'bg-warning',
    low: 'bg-danger',
  }
  return <span className={clsx('inline-block w-2 h-2 rounded-full mr-2', map[level])} />
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export const Button: React.FC<ButtonProps> = ({ children, className, variant = 'primary', size = 'md', ...props }) => {
  const base = 'inline-flex items-center justify-center rounded font-medium transition-colors focus:outline-none disabled:opacity-50'
  const variants = {
    primary: 'bg-deepSea text-white hover:bg-opacity-90',
    secondary: 'bg-steelBlue/10 text-steelBlue hover:bg-steelBlue/20',
    ghost: 'bg-transparent text-textGray hover:bg-borderGray',
    danger: 'bg-danger text-white hover:bg-opacity-90',
  }
  const sizes = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1.5 text-sm',
    lg: 'px-4 py-2 text-sm',
  }
  return (
    <button className={clsx(base, variants[variant], sizes[size], className)} {...props}>
      {children}
    </button>
  )
}
