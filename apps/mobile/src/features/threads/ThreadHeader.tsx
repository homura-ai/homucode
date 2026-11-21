import { useGT, useMessages } from "gt-react-native";
import type { ReactElement } from "react";

import { AppBar } from "../../components/ui/AppBar";
import { ThreadStatusBar, type ThreadStatusSource } from "./ThreadStatusBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly statusLine?: ThreadStatusSource | undefined;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  readonly onFindInThread?: (() => void) | undefined;
  readonly extraMenus?: ReadonlyArray<AppBarMenu>;
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const findAction: AppBarAction[] = props.onFindInThread
    ? [
        {
          accessibilityLabel: gt("Find in thread"),
          icon: "magnifyingglass",
          separateBackground: false,
          onPress: props.onFindInThread,
        },
      ]
    : [];
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        ...findAction,
        {
          accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : findAction;
  const menus = [
    ...(props.extraMenus ?? []),
    ...[gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null),
  ];

  const renderHeader = (titleAccessory?: ReactElement) => (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: gt("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      titleAccessory={titleAccessory ?? null}
      hideBottomBorder
    />
  );
  if (props.statusLine === undefined) return renderHeader();
  return (
    <ThreadStatusBar
      key={`${props.statusLine.environmentId}:${props.statusLine.source.threadId}`}
      {...props.statusLine}
      controlsWidth={48 * (2 + actions.length + menus.length)}
      renderHeader={renderHeader}
    />
  );
}
