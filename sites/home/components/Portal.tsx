'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { User } from '@/lib/types';
import { account, currentUser } from '@/lib/appwrite';
import { Eyebrow } from '@/components/ui/Section';

export function PortalShell({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    void currentUser().then((resolved) => {
      if (!resolved) {
        router.replace('/login');
        return;
      }
      setUser(resolved);
    });
  }, [router]);

  async function logout() {
    await account.deleteSession('current').catch(() => undefined);
    router.replace('/login');
  }

  if (user === undefined) {
    return (
      <main className="portal-main">
        <div className="portal-main__inner">
          <p>Loading account...</p>
        </div>
      </main>
    );
  }

  if (!user) {
    return null;
  }

  const links = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/boards', label: 'Cloud Boards' },
    { href: '/agents', label: 'Agents' },
    { href: '/account', label: 'Account' },
    ...(user.labels || []).includes('admin') ? [{ href: '/admin', label: 'Admin' }] : [],
  ];

  return (
    <main className="portal-layout">
      <aside className="portal-sidebar">
        <Eyebrow>{admin ? 'Admin' : 'User Panel'}</Eyebrow>
        <p className="portal-sidebar__user">{user.name || user.email}</p>
        <nav>
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={pathname === link.href || (link.href !== '/dashboard' && pathname.startsWith(link.href)) ? 'active' : ''}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="portal-sidebar__footer">
          <button className="portal-nav-btn" type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <section className="portal-main">
        <div className="portal-main__inner">{children}</div>
      </section>
    </main>
  );
}
