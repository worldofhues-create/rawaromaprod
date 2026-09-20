'use client';

import { useRouter } from 'next/navigation';
import { LoginForm } from '@core/feature-auth';

/**
 * Sample login route. Renders the reusable @core/feature-auth <LoginForm/>, scoped to this
 * app's portal. The form handles validation (zod from @core/contracts), the mutation
 * (TanStack Query), and session commit (zustand) — the page only wires navigation.
 */
export default function LoginPage() {
  const router = useRouter();
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm">
        <LoginForm
          portal="admin"
          forgotHref="/forgot-password"
          onSuccess={() => router.push('/users')}
        />
      </div>
    </main>
  );
}
