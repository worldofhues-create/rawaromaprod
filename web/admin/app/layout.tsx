import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import type { Portal } from '@core/contracts/registries';
import './globals.css';
import { Providers } from './providers.js';

export const metadata: Metadata = {
  title: 'Admin Console',
  description: 'Reusable admin shell — Next.js 15 App Router template.',
};

/**
 * THEMING.
 * The `data-portal` attribute on <html> selects which :root[data-portal="…"] block of
 * semantic variables (from @core/ui/styles/theme.css, generated from @core/tokens) is
 * active. Every component reads only those vars, so the whole app re-skins from this one
 * attribute. This app is single-role, so it's a constant:
 */
const PORTAL: Portal = 'admin';

/**
 * MULTI-ROLE APPS — switch the theme by the role claim at login.
 * A console serving several roles makes `data-portal` dynamic instead of constant. Read
 * the portal from the authenticated session and set it on <html>, e.g.:
 *
 *   import { cookies } from 'next/headers';
 *   import { portal as portalSchema } from '@core/contracts/registries';
 *
 *   export default async function RootLayout({ children }) {
 *     const claim = (await cookies()).get('portal')?.value;
 *     const portal = portalSchema.catch('admin').parse(claim); // validated role → portal
 *     return (
 *       <html lang="en" data-portal={portal} suppressHydrationWarning>
 *         <body><Providers>{children}</Providers></body>
 *       </html>
 *     );
 *   }
 *
 * The portal comes from the JWT audience/role claim set during login (the same `portal`
 * field on every auth request/response in @core/contracts). REBRAND = edit the token files
 * in @core/tokens and regenerate theme.css — ZERO component or app edits.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-portal={PORTAL} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
