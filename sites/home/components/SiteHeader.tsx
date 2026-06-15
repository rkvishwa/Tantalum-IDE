'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

const navLinks = [
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
  { href: '/download', label: 'Download' },
  { href: '/support', label: 'Support' },
  { href: '/about', label: 'About' },
];

export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="site-brand" href="/" onClick={() => setMobileOpen(false)}>
          <BrandLogo />
          <span>Tantalum IDE</span>
        </Link>

        <nav className="site-nav" aria-label="Primary">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="site-header__actions">
          <ThemeToggle />
          <Link className="site-nav-link site-nav-link--ghost" href="/login">Login</Link>
          <Button variant="primary" size="sm" href="/download">Download</Button>
          <Button variant="secondary" size="sm" href="/register">Create Account</Button>
          <IconButton
            className="site-header__menu"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </IconButton>
        </div>
      </div>

      {mobileOpen ? (
        <nav className="site-mobile-nav" aria-label="Mobile">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} onClick={() => setMobileOpen(false)}>
              {link.label}
            </Link>
          ))}
          <Link href="/login" onClick={() => setMobileOpen(false)}>Login</Link>
          <Link href="/register" onClick={() => setMobileOpen(false)}>Create Account</Link>
        </nav>
      ) : null}
    </header>
  );
}
