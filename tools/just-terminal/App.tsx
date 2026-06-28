import { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectScreen } from "./src/components/ConnectScreen";
import { TerminalScreen } from "./src/TerminalScreen";
import { buildEndpoint, type ServerEndpoint } from "./src/lib/endpoint";
import { probeServer } from "./src/lib/api";
import { terminalSocket } from "./src/lib/socket";
import { forgetServer, loadServers, rememberServer } from "./src/lib/storage";
import { useAppFonts } from "./src/useAppFonts";
import { colors } from "./src/theme";

// Hold the native splash (branded chevron on the app background) until the JS is
// mounted and fonts are ready, so launch never flashes a blank/unstyled frame.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const fontsLoaded = useAppFonts();
  const [servers, setServers] = useState<ServerEndpoint[]>([]);
  const [endpoint, setEndpoint] = useState<ServerEndpoint | undefined>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    loadServers().then(setServers);
  }, []);

  const connect = useCallback(async (target: ServerEndpoint) => {
    setError(undefined);
    setConnecting(true);
    const reachable = await probeServer(target);
    if (!reachable) {
      setConnecting(false);
      setError(`Could not reach ${target.host}. Check the address, token, and that the host is running.`);
      return;
    }
    const next = await rememberServer(target);
    setServers(next);
    terminalSocket.configure(target);
    terminalSocket.connect();
    setEndpoint(target);
    setConnecting(false);
  }, []);

  const onConnect = useCallback(
    (address: string, token: string, label?: string) => {
      const target = buildEndpoint(address, token, label);
      if (!target) {
        setError("Enter a valid address, e.g. 192.168.1.50:10001");
        return;
      }
      void connect(target);
    },
    [connect]
  );

  const onDisconnect = useCallback(() => {
    terminalSocket.disconnect();
    setEndpoint(undefined);
    setError(undefined);
  }, []);

  const onForget = useCallback((id: string) => {
    forgetServer(id).then(setServers);
  }, []);

  // Reveal the app (dismiss the native splash) only once the first real frame
  // has laid out, so there's no flash between splash and content.
  const onLayoutRootView = useCallback(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded]);

  // Keep the native splash up until fonts are ready.
  if (!fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.root} onLayout={onLayoutRootView}>
        {endpoint ? (
          <TerminalScreen endpoint={endpoint} onDisconnect={onDisconnect} />
        ) : (
          <ConnectScreen
            servers={servers}
            connecting={connecting}
            error={error}
            onConnect={onConnect}
            onSelectSaved={(saved) => void connect(saved)}
            onForget={onForget}
          />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
