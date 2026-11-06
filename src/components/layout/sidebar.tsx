'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  FolderKanban,
  LayoutDashboard,
  Activity,
  Shield,
  KeyRound,
  LogOut,
  X,
} from 'lucide-react';
import { useAdminAuth } from '@/context/admin-auth-context';

interface SidebarProps {
  isOpenOnMobile?: boolean;
  onCloseMobile?: () => void;
}

export function Sidebar({ isOpenOnMobile = false, onCloseMobile }: SidebarProps) {
  const pathname = usePathname();
  const { logout, admin } = useAdminAuth();

  const navItems = [
    {
      label: 'Projects',
      href: '/admin/projects',
      icon: FolderKanban,
    },
    {
      label: 'Overview',
      href: '/admin/overview',
      icon: LayoutDashboard,
    },
    {
      label: 'Monitoring',
      href: '/admin/monitoring',
      icon: Activity,
    },
  ];

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpenOnMobile && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onCloseMobile}
        />
      )}

      {/* Sidebar container */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col w-64 bg-card border-r border-border transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 ${
          isOpenOnMobile ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand & logo header */}
        <div className="flex items-center justify-between h-16 px-6 border-b border-border">
          <Link href="/admin/projects" className="flex items-center gap-2.5" onClick={onCloseMobile}>
            <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center text-primary-foreground font-bold shadow-md shadow-primary/20">
              <Shield className="w-4 h-4" />
            </div>
            <div className="flex flex-col">
              <span className="font-semibold text-sm tracking-tight text-foreground">Antigravity Gateway</span>
              <span className="text-[10px] text-muted-foreground font-mono">Admin Console</span>
            </div>
          </Link>
          {onCloseMobile && (
            <button
              type="button"
              onClick={onCloseMobile}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground lg:hidden min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Tutup navigasi"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Navigation list */}
        <div className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <div className="px-3 mb-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
            Manajemen
          </div>
          {navItems.map((item) => {
            const isActive = pathname === item.href || pathname?.startsWith(item.href + '/');
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onCloseMobile}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors min-h-[44px] ${
                  isActive
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>

        {/* Admin profile & logout footer */}
        <div className="p-4 border-t border-border bg-card/50">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="truncate">
              <p className="text-xs font-medium text-foreground truncate">{admin?.email || 'Administrator'}</p>
              <p className="text-[10px] text-muted-foreground capitalize">{admin?.role || 'Admin Sesi'}</p>
            </div>
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" title="Sesi Aktif" />
          </div>
          <button
            type="button"
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-md text-destructive hover:bg-destructive/10 border border-destructive/20 transition-colors min-h-[44px] cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Keluar Sesi</span>
          </button>
        </div>
      </aside>
    </>
  );
}
