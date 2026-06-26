import type { ReactNode } from 'react';
import Link from 'next/link';
import { LayoutDashboard, Users, Settings, ShieldCheck } from 'lucide-react';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/users', label: 'Users', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

/**
 * Dashboard shell — persistent sidebar + header, built entirely from semantic tokens
 * (bg-surface, border-border, text-accent, …). No domain vocabulary; this is the generic
 * app frame a new project keeps and fills with its own routes.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-bg text-text">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="flex items-center gap-2 px-5 py-4 text-lg font-semibold">
          <ShieldCheck className="size-5 text-accent" />
          <span>Console</span>
        </div>
        <nav className="flex flex-col gap-1 px-3 py-2">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
          <span className="text-sm font-medium text-text-muted">Admin</span>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
