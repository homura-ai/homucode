import { useFonts } from "expo-font";
import { createContext, useContext, type ReactNode } from "react";

import { AppText, type AppTextProps } from "../../components/ui/AppText";

const FONT_ASSETS = {
  "Inter-Regular": require("../../../assets/fonts/inter/Inter-Regular.ttf"),
  "Inter-Medium": require("../../../assets/fonts/inter/Inter-Medium.ttf"),
  "Inter-SemiBold": require("../../../assets/fonts/inter/Inter-SemiBold.ttf"),
};

export const StatusLineInterLoaded = createContext(false);

export function StatusLineTypography({ children }: { readonly children: ReactNode }) {
  const [loaded] = useFonts(FONT_ASSETS);
  return <StatusLineInterLoaded.Provider value={loaded}>{children}</StatusLineInterLoaded.Provider>;
}

export function StatusLineText({
  style,
  medium,
  ...props
}: AppTextProps & { readonly medium?: boolean }) {
  const loaded = useContext(StatusLineInterLoaded);
  return (
    <AppText
      {...props}
      style={[
        style,
        loaded
          ? { fontFamily: medium ? "Inter-Medium" : "Inter-Regular", fontWeight: "normal" }
          : undefined,
      ]}
    />
  );
}
