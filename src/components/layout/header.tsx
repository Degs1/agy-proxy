'use client';

import React, { useState, useEffect } from 'react';
import { Menu, Activity, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface HeaderProps {
  onOpenMobileMenu: () => void;
  title?: string;
}

export function Header({ onOpenMobileMenu, title }: HeaderProps) {
  const [utcTime, setUtcTime] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setUtcTime(now.toUTCString().slice(17, 25) + ' UTC');
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="h-16 border-b border-border bg-card px-4 lg:px-8 flex items-center justify-between gap-4 sticky top-0 z-30">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Buka menu navigasi"
          className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted lg:hidden min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
        >
          <Menu className="w-5 h-5" />
        </button>
        {title && <h1 className="text-base lg:text-lg font-semibold text-foreground tracking-tight">{title}</h1>}
      </div>

      <div className="flex items-center gap-3">
        {/* System Health Badge */}
        <Badge variant="active" className="hidden sm:inline-flex">
          Atlas Connected
        </Badge>

        {/* UTC Clock */}
        <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground font-mono bg-muted/60 px-2.5 py-1 rounded-md border border-border">
          <Clock className="w-3.5 h-3.5" />
          <span>{utcTime || 'UTC'}</span>
        </div>
      </div>
    </header>
  );
}
