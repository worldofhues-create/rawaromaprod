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
import { useLogin } from '../core/useLogin.js';
import type { LoginRequest } from '../core/api-client.js';

export interface LoginFormProps {
  /** The portal this app authenticates against — becomes the JWT audience claim. */
  portal: Portal;
  /** Called after a successful login (e.g. router push). */
  onSuccess?: () => void;
  /** Link target for the "forgot password" affordance. */
  forgotHref?: string;
  className?: string;
}

export function LoginForm({ portal, onSuccess, forgotHref, className }: LoginFormProps) {
  const login = useLogin();

  const form = useForm<LoginRequest>({
    resolver: zodResolver(identity.auth.loginRequest),
    defaultValues: { identifier: '', password: '', portal },
  });

  const onSubmit = form.handleSubmit((values) => {
    login.mutate(values, { onSuccess: () => onSuccess?.() });
  });

  const idError = form.formState.errors.identifier?.message;
  const pwError = form.formState.errors.password?.message;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Enter your credentials to continue.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="flex flex-col gap-4">
          <input type="hidden" {...form.register('portal')} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="identifier">Email or mobile</Label>
            <Input
              id="identifier"
              autoComplete="username"
              aria-invalid={Boolean(idError)}
              {...form.register('identifier')}
            />
            {idError ? <p className="text-xs text-danger">{idError}</p> : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              {forgotHref ? (
                <a href={forgotHref} className="text-xs text-accent hover:underline">
                  Forgot password?
                </a>
              ) : null}
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(pwError)}
              {...form.register('password')}
            />
            {pwError ? <p className="text-xs text-danger">{pwError}</p> : null}
          </div>

          {login.isError ? (
            <p className="text-sm text-danger" role="alert">
              {login.error.message || 'Could not sign in. Please try again.'}
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
