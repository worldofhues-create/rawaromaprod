import '../global.css';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@core/ui-native';
import type { Portal } from '@core/tokens';
import { AuthEndpointsProvider } from '../lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

/**
 * Root providers, outer → inner:
 *   SafeAreaProvider  — insets for <Screen> / safe-area-aware components
 *   QueryClientProvider — TanStack Query (all server state)
 *   AuthEndpointsProvider — injects the typed API client/endpoints (transport)
 *   ThemeProvider     — applies the active portal's @core/tokens as NativeWind CSS vars
 *
 * THEME PER ROLE: the consumer app is single-portal, so we hard-set portal="buyer". A
 * multi-role app (e.g. Partner = owner|builder) instead reads the portal from the JWT role
 * claim returned at login and passes it here — or calls `useTheme().setPortal(...)` after
 * login — so the whole app re-skins to that role. Rebranding = edit @core/tokens only.
 */
const APP_PORTAL: Portal = 'buyer';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthEndpointsProvider>
          <ThemeProvider portal={APP_PORTAL}>
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(auth)/login" />
            </Stack>
          </ThemeProvider>
        </AuthEndpointsProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
