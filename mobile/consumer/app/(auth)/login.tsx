import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { identity } from '@core/contracts';
import type { Portal } from '@core/tokens';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Screen,
  Text,
} from '@core/ui-native';
import { useLogin, type LoginRequest } from '@core/mobile-core';
import { useAuthEndpoints } from '../../lib/api';

/** Single-portal app → the JWT audience claim it authenticates against. */
const APP_PORTAL: Portal = 'buyer';

/**
 * Login screen. The mobile mirror of web's <LoginForm>:
 *   - validation schema is the SAME @core/contracts `identity.auth.loginRequest` (one source
 *     of truth shared with the backend),
 *   - form via react-hook-form + @hookform/resolvers/zod,
 *   - UI composed only from @core/ui-native (themed by the active portal),
 *   - submit drives @core/mobile-core's `useLogin`, which persists tokens to SecureStore and
 *     commits the session to the zustand store.
 */
export default function LoginScreen() {
  const router = useRouter();
  const endpoints = useAuthEndpoints();
  const login = useLogin(endpoints);

  const form = useForm<LoginRequest>({
    resolver: zodResolver(identity.auth.loginRequest),
    defaultValues: { identifier: '', password: '', portal: APP_PORTAL },
  });

  const onSubmit = form.handleSubmit((values) => {
    login.mutate(values, { onSuccess: () => router.replace('/') });
  });

  const idError = form.formState.errors.identifier?.message;
  const pwError = form.formState.errors.password?.message;

  return (
    <Screen>
      <View className="flex-1 justify-center">
        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Enter your credentials to continue.</CardDescription>
          </CardHeader>
          <CardContent>
            <Controller
              control={form.control}
              name="identifier"
              render={({ field }) => (
                <Input
                  label="Email or mobile"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  value={field.value ?? ''}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={idError}
                />
              )}
            />

            <Controller
              control={form.control}
              name="password"
              render={({ field }) => (
                <Input
                  label="Password"
                  secureTextEntry
                  autoCapitalize="none"
                  value={field.value ?? ''}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={pwError}
                />
              )}
            />

            {login.isError ? (
              <Text variant="danger">
                {login.error.message || 'Could not sign in. Please try again.'}
              </Text>
            ) : null}
          </CardContent>
          <CardFooter>
            <Button
              className="w-full"
              loading={login.isPending}
              onPress={onSubmit}
            >
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </CardFooter>
        </Card>
      </View>
    </Screen>
  );
}
