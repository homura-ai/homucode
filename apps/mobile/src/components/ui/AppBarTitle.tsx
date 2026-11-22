import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText } from "./AppText";

interface AppBarTitleProps {
  readonly title: string;
  readonly subtitle?: string | null | undefined;
  readonly accessory: ReactNode;
}

export function AppBarTitle(props: AppBarTitleProps) {
  return (
    <View className="min-w-0 flex-row items-center gap-5">
      <View className="min-w-0 shrink">
        <AppText
          numberOfLines={1}
          className="text-xl text-header-foreground ios:text-base ios:font-semibold"
        >
          {props.title}
        </AppText>
        {props.subtitle ? (
          <AppText numberOfLines={1} className="text-xs text-foreground-muted">
            {props.subtitle}
          </AppText>
        ) : null}
      </View>
      {props.accessory}
    </View>
  );
}

export function renderAppBarTitle(props: AppBarTitleProps) {
  return () => <AppBarTitle {...props} />;
}
