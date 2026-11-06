import React, { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'destructive' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className = '',
      variant = 'primary',
      size = 'md',
      isLoading = false,
      disabled,
      children,
      type = 'button',
      ...props
    },
    ref
  ) => {
    let variantStyles = 'bg-primary text-primary-foreground hover:bg-primary/90';
    if (variant === 'secondary') {
      variantStyles = 'bg-muted text-foreground hover:bg-muted/80 border border-border';
    } else if (variant === 'destructive') {
      variantStyles = 'bg-destructive text-destructive-foreground hover:bg-destructive/90';
    } else if (variant === 'outline') {
      variantStyles = 'border border-border bg-transparent text-foreground hover:bg-muted';
    } else if (variant === 'ghost') {
      variantStyles = 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50';
    }

    let sizeStyles = 'min-h-[44px] px-4 py-2 text-sm';
    if (size === 'sm') {
      sizeStyles = 'min-h-[36px] md:min-h-[44px] px-3 py-1.5 text-xs';
    } else if (size === 'lg') {
      sizeStyles = 'min-h-[48px] px-6 py-3 text-base';
    } else if (size === 'icon') {
      sizeStyles = 'w-11 h-11 p-2 flex items-center justify-center';
    }

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || isLoading}
        aria-disabled={disabled || isLoading}
        className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-all duration-150 ease-in-out cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none disabled:active:scale-100 ${variantStyles} ${sizeStyles} ${className}`}
        {...props}
      >
        {isLoading && <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
