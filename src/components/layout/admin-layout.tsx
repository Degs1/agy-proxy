'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminAuthProvider, useAdminAuth } from '@/context/admin-auth-context';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { Skeleton } from '@/components/ui/skeleton';

function AdminShell({ children, title }: { children: React.ReactNode; title?: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { admin, isLoading } = useAdminAuth();
  const router = useRouter();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 space-y-4">
        <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center animate-pulse">
          <div className="w-6 h-6 rounded-lg bg-primary animate-spin" />
        </div>
        <p className="text-sm text-muted-foreground animate-pulse">Memverifikasi sesi administrasi...</p>
      </div>
    );
  }

  if (!admin) {
    if (typeof window !== 'undefined') {
      router.push('/admin/login');
    }
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Mengarahkan ke halaman login...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar */}
      <Sidebar isOpenOnMobile={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header onOpenMobileMenu={() => setMobileOpen(true)} title={title} />
        <main className="flex-1 p-4 lg:p-8 max-w-7xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}

export function AdminLayout({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <AdminAuthProvider>
      <AdminShell title={title}>{children}</AdminShell>
    </AdminAuthProvider>
  );
}
