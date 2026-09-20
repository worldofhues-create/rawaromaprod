'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { identity } from '@core/contracts';
import type { Portal } from '@core/contracts/registries';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@core/ui';
import { useRegister } from '../core/useRegister.js';
import type { RegisterRequest } from '../core/api-client.js';

export interface RegisterFormProps {
  /** The portal new accounts are scoped to. */
  portal: Portal;
  onSuccess?: () => void;
  loginHref?: string;
  className?: string;
}

export function RegisterForm({ portal, onSuccess, loginHref, className }: RegisterFormProps) {
  const register = useRegister();

  const form = useForm<RegisterRequest>({
    resolver: zodResolver(identity.auth.registerRequest),
    defaultValues: { fullName: '', email: '', mobile: '', portal },
  });

  const onSubmit = form.handleSubmit((values) => {
    register.mutate(values, { onSuccess: () => onSuccess?.() });
  });

  const { errors } = form.formState;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>It only takes a minute.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="flex flex-col gap-4">
          <input type="hidden" {...form.register('portal')} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fullName">Full name</Label>
            <Input
              id="fullName"
              autoComplete="name"
              aria-invalid={Boolean(errors.fullName)}
              {...form.register('fullName')}
            />
            {errors.fullName ? <p className="text-xs text-danger">{errors.fullName.message}</p> : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              aria-invalid={Boolean(errors.email)}
              {...form.register('email')}
            />
            {errors.email ? <p className="text-xs text-danger">{errors.email.message}</p> : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mobile">Mobile</Label>
            <Input
              id="mobile"
              type="tel"
              autoComplete="tel"
              placeholder="+91…"
              aria-invalid={Boolean(errors.mobile)}
              {...form.register('mobile')}
            />
            {errors.mobile ? <p className="text-xs text-danger">{errors.mobile.message}</p> : null}
          </div>

          <label className="flex items-start gap-2 text-sm text-text">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
              {...form.register('acceptedTerms')}
            />
            <span>I accept the Terms of Service.</span>
          </label>
          {errors.acceptedTerms ? (
            <p className="-mt-2 text-xs text-danger">You must accept the Terms.</p>
          ) : null}

          <label className="flex items-start gap-2 text-sm text-text">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
              {...form.register('acceptedPrivacy')}
            />
            <span>I accept the Privacy Policy.</span>
          </label>
          {errors.acceptedPrivacy ? (
            <p className="-mt-2 text-xs text-danger">You must accept the Privacy Policy.</p>
          ) : null}

          {register.isError ? (
            <p className="text-sm text-danger" role="alert">
              {register.error.message || 'Could not create your account. Please try again.'}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3">
          <Button type="submit" className="w-full" disabled={register.isPending}>
            {register.isPending ? 'Creating…' : 'Create account'}
          </Button>
          {loginHref ? (
            <p className="text-center text-sm text-text-muted">
              Already have an account?{' '}
              <a href={loginHref} className="text-accent hover:underline">
                Sign in
              </a>
            </p>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  );
}
