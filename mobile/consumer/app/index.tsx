import { View } from 'react-native';
import { Link, Redirect } from 'expo-router';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Screen, Text } from '@core/ui-native';
import { useLogout, useSessionStore } from '@core/mobile-core';

/**
 * Authed home placeholder. Redirects to the login screen when anonymous; otherwise shows the
 * current session. Demonstrates: composing only @core/ui-native primitives (all themed via
 * the active portal), reading session state from @core/mobile-core's zustand store, and the
 * trust Badge variant (the signature accent).
 */
export default function HomeScreen() {
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const logout = useLogout();

  if (status === 'anonymous') {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Screen>
      <View className="gap-4">
        <Text variant="heading">Home</Text>

        <Card>
          <CardHeader>
            <CardTitle>Session</CardTitle>
          </CardHeader>
          <CardContent>
            {user ? (
              <>
                <Text>{user.fullName}</Text>
                <Text variant="muted">Portal: {user.portal}</Text>
                <Badge variant="trust">Verified</Badge>
              </>
            ) : (
              <Text variant="muted">Loading session…</Text>
            )}
          </CardContent>
        </Card>

        <Link href="/(auth)/login" asChild>
          <Button variant="outline">Go to login</Button>
        </Link>

        <Button variant="danger" loading={logout.isPending} onPress={() => logout.mutate()}>
          Sign out
        </Button>
      </View>
    </Screen>
  );
}
