import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useCallback, useMemo } from "react";
import { Platform, Text, View } from "react-native";
import { findChatList } from "./client/fiber";
import { createNavigator, type Direction, type NavigationResult } from "./client/navigator";

const STATUS_DURATION_MS = 2500;

const PILLS: Record<Direction, { title: string; label: string; glyph: string }> = {
  older: { title: "Jump to previous prompt", label: "Prev", glyph: "↑" },
  newer: { title: "Jump to next prompt", label: "Next", glyph: "↓" },
};

const STATUS_LABELS: Partial<Record<NavigationResult | "no-fiber" | "no-root" | "no-list", string>> =
  {
    "oldest-loaded": "Top",
    latest: "Latest",
    "no-prompts": "None",
    "no-metrics": "No metrics",
    unsettled: "Missed",
    "no-fiber": "No fiber",
    "no-root": "No root",
    "no-list": "No list",
  };

export default function contribute(client: PluginClientContext) {
  // The hack only targets the native FlatList. Web has the chat outline.
  if (Platform.OS === "web") return () => {};

  const anchors = new Map<string, unknown>();
  const pills = new Map<string, PluginButtonRegistration<string>[]>();
  const statusTimers = new Set<ReturnType<typeof setTimeout>>();
  const navigator = createNavigator({
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  /** The pill's icon is the only view a plugin can mount beside the chat, so it is the way in. */
  function createAnchorIcon(direction: Direction) {
    return function AnchorIcon(props: PluginButtonIconProps) {
      const { size, color } = props;
      const agent = props.context === "agent" ? props.agentId : null;
      const attach = useCallback(
        (host: unknown) => {
          if (!agent) return;
          if (host) anchors.set(agent, host);
          else anchors.delete(agent);
        },
        [agent],
      );
      const style = useMemo(
        () => ({ width: size, height: size, alignItems: "center", justifyContent: "center" }) as const,
        [size],
      );
      const textStyle = useMemo(() => ({ color, fontSize: size, lineHeight: size }), [color, size]);
      return (
        <View ref={attach} collapsable={false} style={style}>
          <Text style={textStyle}>{PILLS[direction].glyph}</Text>
        </View>
      );
    };
  }
  const icons: Record<Direction, ReturnType<typeof createAnchorIcon>> = {
    older: createAnchorIcon("older"),
    newer: createAnchorIcon("newer"),
  };

  function showStatus(pill: PluginButtonRegistration<string>, direction: Direction, label: string) {
    pill.update({ label });
    const timer = setTimeout(() => {
      statusTimers.delete(timer);
      pill.update({ label: PILLS[direction].label });
    }, STATUS_DURATION_MS);
    statusTimers.add(timer);
  }

  function addPills(agentId: string, workspaceId: string) {
    if (pills.has(agentId)) return;
    const registrations = (["older", "newer"] as const).map((direction) => {
      const pill: PluginButtonRegistration<string> = client.addComposerPill({
        id: `${direction}-${agentId}`,
        workspaceId,
        agentId,
        button: {
          title: PILLS[direction].title,
          label: PILLS[direction].label,
          icon: icons[direction],
          behavior: {
            kind: "action",
            async onPress() {
              const found = findChatList(anchors.get(agentId));
              if (!found.ok) {
                showStatus(pill, direction, STATUS_LABELS[found.reason] ?? found.reason);
                return;
              }
              const result = await navigator.navigate(found.list, direction);
              const status = STATUS_LABELS[result];
              if (status) showStatus(pill, direction, status);
            },
          },
        },
      });
      return pill;
    });
    pills.set(agentId, registrations);
  }

  function removePills(agentId: string) {
    pills.get(agentId)?.forEach((pill) => pill.remove());
    pills.delete(agentId);
    anchors.delete(agentId);
  }

  function syncAgent(agent: { id: string; workspaceId?: string | null; archivedAt?: unknown }) {
    if (agent.archivedAt) removePills(agent.id);
    else if (agent.workspaceId) addPills(agent.id, agent.workspaceId);
  }

  const stopListening = client.paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") syncAgent(update.agent);
    else removePills(update.agentId);
  });
  void client.paseo.agents
    .list()
    .then(({ entries }) => entries.forEach((entry) => syncAgent(entry.agent)))
    .catch((error) => console.warn("[paseo-prompt-nav] Could not list agents", error));

  return () => {
    stopListening();
    statusTimers.forEach(clearTimeout);
    for (const agentId of [...pills.keys()]) removePills(agentId);
  };
}
