import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { type ReactElement, type ReactNode } from "react";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { ThreadStatusBar, type ThreadStatusSource } from "./ThreadStatusBar";
import { LocalPreviewScreen } from "../browser/LocalPreviewRouteScreen";
import { DevicePreviewScreen } from "../devices/DevicePreviewRouteScreen";
import {
  WorkspaceContentWidthContext,
  WorkspaceSettledContentWidthContext,
} from "../layout/workspace-content-width";
import {
  ThreadInspectorNavigationContext,
  type ThreadInspectorTarget,
} from "./thread-inspector-navigation";
import type { MadoHomuThreadRouteParams } from "./thread-route-state";
import { ThreadPreviewRoute } from "./thread-preview-route";

/** A thread shown outside its route: in the inspector pane, or presented full screen with a close. */
export type ThreadInspectorPresentation =
  | { readonly onMaximize: () => void }
  | { readonly onClose: () => void };

export function ThreadInspectorHeader(
  props: ThreadInspectorPresentation & {
    readonly title: string;
    readonly subtitle?: string;
    readonly statusLine?: ThreadStatusSource | undefined;
  },
) {
  const gt = useGT();
  const renderHeader = (titleAccessory?: ReactElement) =>
    "onMaximize" in props ? (
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        titleAccessory={titleAccessory ?? null}
        actions={[
          {
            accessibilityLabel: gt("Maximize thread"),
            icon: "arrow.up.left.and.arrow.down.right",
            onPress: props.onMaximize,
          },
        ]}
      />
    ) : (
      <SheetHeader
        title={props.title}
        subtitle={props.subtitle}
        onClose={props.onClose}
        accessibilityLabel={gt("Close thread")}
        titleAccessory={titleAccessory ?? null}
      />
    );
  if (props.statusLine === undefined) return renderHeader();
  return (
    <ThreadStatusBar
      key={`${props.statusLine.environmentId}:${props.statusLine.source.threadId}`}
      {...props.statusLine}
      controlsWidth={"onMaximize" in props ? 96 : 48}
      renderHeader={renderHeader}
    />
  );
}

/** A thread shown beside or over the workspace does not take the workspace's content width. */
export function InspectorContentScope({ children }: { readonly children: ReactNode }) {
  return (
    <WorkspaceContentWidthContext value={null}>
      <WorkspaceSettledContentWidthContext value={null}>
        {children}
      </WorkspaceSettledContentWidthContext>
    </WorkspaceContentWidthContext>
  );
}

export function ThreadInspectorPreview(props: {
  readonly target: ThreadInspectorTarget;
  readonly onClose: () => void;
  readonly onOpen: (target: ThreadInspectorTarget) => void;
  readonly renderThread: (
    props: StaticScreenProps<
      { readonly environmentId: string; readonly threadId: string } & MadoHomuThreadRouteParams
    > & {
      readonly inspectorPresentation: ThreadInspectorPresentation;
    },
  ) => ReactNode;
}) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const { target } = props;
  const maximizeDevice = (deviceKey: string | null) => {
    props.onOpen({ ...target, deviceKey: deviceKey ?? undefined });
    navigation.navigate("ThreadDevicePreview", {
      environmentId: target.environmentId,
      threadId: target.threadId,
      deviceKey: deviceKey ?? undefined,
    });
  };
  if (!focused) return null;
  return (
    <ThreadInspectorNavigationContext value={props.onOpen}>
      <InspectorContentScope>
        {target.type === "localPreview" && target.url ? (
          <LocalPreviewScreen
            key={`${target.environmentId}:${target.url}`}
            environmentId={EnvironmentId.make(target.environmentId)}
            url={target.url}
            onClose={props.onClose}
            onMaximize={(url) => {
              props.onOpen({ ...target, url });
              navigation.navigate("ThreadLocalPreview", {
                environmentId: target.environmentId,
                url,
              });
            }}
          />
        ) : target.type === "device" ? (
          <DevicePreviewScreen
            key={`${target.environmentId}:${target.threadId}`}
            environmentId={EnvironmentId.make(target.environmentId)}
            threadId={ThreadId.make(target.threadId)}
            initialDeviceKey={target.deviceKey}
            onClose={props.onClose}
            onMaximize={maximizeDevice}
          />
        ) : (
          <View className="flex-1 bg-screen">
            <ThreadPreviewRoute
              environmentId={target.environmentId}
              threadId={target.threadId}
              {...(target.madohomu ? { madohomu: true } : {})}
              {...(target.madohomuLinkProjectId
                ? { madohomuLinkProjectId: target.madohomuLinkProjectId }
                : {})}
            >
              {(route) =>
                props.renderThread({
                  route,
                  inspectorPresentation: {
                    onMaximize: () =>
                      navigation.navigate("ThreadInspectorFullscreen", route.params),
                  },
                })
              }
            </ThreadPreviewRoute>
          </View>
        )}
      </InspectorContentScope>
    </ThreadInspectorNavigationContext>
  );
}
