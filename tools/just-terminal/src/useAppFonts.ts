import { useFonts } from "expo-font";
import {
  CascadiaMono_400Regular,
  CascadiaMono_600SemiBold,
} from "@expo-google-fonts/cascadia-mono";
import { CascadiaCode_600SemiBold } from "@expo-google-fonts/cascadia-code";

// Windows Terminal's own faces: Selawik is Microsoft's open (SIL OFL),
// metric-compatible twin of Segoe UI for the WinUI chrome; Cascadia
// Mono/Code render terminal and brand text exactly like the desktop app.
export function useAppFonts(): boolean {
  const [loaded] = useFonts({
    Selawik: require("../assets/fonts/Selawik-Regular.ttf"),
    "Selawik-Semibold": require("../assets/fonts/Selawik-Semibold.ttf"),
    "Selawik-Bold": require("../assets/fonts/Selawik-Bold.ttf"),
    CascadiaMono_400Regular,
    CascadiaMono_600SemiBold,
    CascadiaCode_600SemiBold,
  });
  return loaded;
}
