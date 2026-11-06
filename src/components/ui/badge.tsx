import React from 'react';
import { CheckCircle2, PauseCircle, XCircle, Clock, AlertCircle } from 'lucide-react';

export type BadgeVariant = 'active' | 'disabled' | 'revoked' | 'warning' | 'error' | 'neutral';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  showIcon?: boolean;
  children: React.ReactNode;
}

export function Badge({
  variant = 'neutral',
  showIcon = true,
  children,
  className = '',
  ...props
}: BadgeProps) {
  let colorClasses = 'bg-muted text-muted-foreground border-border';
  let IconComponent = null;

  switch (variant) {
    case 'active':
      colorClasses = 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
      IconComponent = CheckCircle2;
      break;
    case 'disabled':
      colorClasses = 'bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/30';
      IconComponent = PauseCircle;
      break;
    case 'revoked':
    case 'error':
      colorClasses = 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30';
      IconComponent = XCircle;
      break;
    case 'warning':
      colorClasses = 'bg-yellow-500/10 text-amber-800 dark:text-yellow-400 border-yellow-500/30';
      IconComponent = Clock;
      break;
    default:
      colorClasses = 'bg-muted text-muted-foreground border-border';
      IconComponent = AlertCircle;
      break;
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-badge rounded-[4px] font-mono text-[11px] font-medium border ${colorClasses} ${className}`}
      {...props}
    >
      {showIcon && IconComponent && <IconComponent className="w-3 h-3 shrink-0" aria-hidden="true" />}
      <span>{children}</span>
    </span>
  );
}
