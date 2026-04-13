import { computed, type ComputedRef } from "vue";
import type {
  PluginDashboardCardContribution,
  PluginInfo,
} from "@/types/api.plugin";
import { useAppStore } from "@/stores/app";
import { CardRegistry } from "@/dashboard/core/cardRegistry";
import type {
  BuiltinDashboardCardContribution,
  DashboardCardContribution,
} from "@/dashboard/core/types";

function toDashboardContribution(
  card: PluginDashboardCardContribution,
  pluginName: string
): DashboardCardContribution {
  if (card.renderer.kind === "builtin") {
    return {
      ...card,
      source: "plugin",
      pluginName,
      renderer: {
        kind: "builtin",
        componentKey: card.renderer.componentKey,
        buildProps: () => ({}),
      },
    };
  }

  return {
    ...card,
    source: "plugin",
    pluginName,
    renderer: {
      kind: "web-component",
      tagName: card.renderer.tagName,
      publicPath: card.renderer.publicPath,
    },
  };
}

function normalizePluginCards(plugin: PluginInfo): DashboardCardContribution[] {
  if (!plugin.enabled || !Array.isArray(plugin.dashboardCards)) {
    return [];
  }

  return plugin.dashboardCards
    .filter((card): card is PluginDashboardCardContribution => Boolean(card))
    .map((card) => toDashboardContribution(card, card.pluginName || plugin.manifest.name));
}

export function useDashboardCatalog(
  builtinCards: ComputedRef<BuiltinDashboardCardContribution[]>
) {
  const appStore = useAppStore();

  const plugins = computed(() => appStore.plugins as PluginInfo[]);
  const pluginCards = computed<DashboardCardContribution[]>(() =>
    plugins.value.flatMap((plugin) => normalizePluginCards(plugin))
  );
  const cards = computed<DashboardCardContribution[]>(() => [
    ...builtinCards.value,
    ...pluginCards.value,
  ]);
  const registry = computed(() => {
    const nextRegistry = new CardRegistry();
    nextRegistry.registerMany(cards.value);
    return nextRegistry;
  });
  const contributionMap = computed(() => {
    return new Map(cards.value.map((card) => [card.typeId, card] as const));
  });
  const legacyIdMap = computed(() => {
    return new Map(
      cards.value
        .filter((card) => card.legacyId)
        .map((card) => [card.legacyId as string, card] as const)
    );
  });
  const catalogReady = computed(() => appStore.pluginsLoaded);

  return {
    cards,
    catalogReady,
    contributionMap,
    legacyIdMap,
    pluginCards,
    registry,
  };
}
