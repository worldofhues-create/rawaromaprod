'use client';

import { useForm } from 'react-hook-form';
import { useMutation } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { identity } from '@core/contracts';
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
import { useAuthApi } from '../core/auth-client-context.js';
import type { ForgotPasswordRequest } from '../core/api-client.js';

export interface ForgotPasswordFormProps {
  loginHref?: string;
  className?: string;
}

export function ForgotPasswordForm({ loginHref, className }: ForgotPasswordFormProps) {
  const api = useAuthApi();
  const submit = useMutation<{ ok: true }, Error, ForgotPasswordRequest>({
    mutationKey: ['auth', 'forgot-password'],
    mutationFn: (body) => api.forgotPassword(body),
  });

  const form = useForm<ForgotPasswordRequest>({
    resolver: zodResolver(identity.auth.forgotPasswordRequest),
    defaultValues: { identifier: '' },
  });

  const onSubmit = form.handleSubmit((values) => submit.mutate(values));
  const idError = form.formState.errors.identifier?.message;

  if (submit.isSuccess) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Check your inbox</CardTitle>
          <CardDescription>
            If an account exists, we&apos;ve sent reset instructions.
          </CardDescription>
        </CardHeader>
        {loginHref ? (
          <CardFooter>
            <a href={loginHref} className="text-sm text-accent hover:underline">
              Back to sign in
            </a>
          </CardFooter>
        ) : null}
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Reset password</CardTitle>
        <CardDescription>We&apos;ll send a reset link to your account.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="flex flex-col gap-4">
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
          {submit.isError ? (
            <p className="text-sm text-danger" role="alert">
              {submit.error.message || 'Something went wrong. Please try again.'}
            </p>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={submit.isPending}>
            {submit.isPending ? 'Sending…' : 'Send reset link'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
