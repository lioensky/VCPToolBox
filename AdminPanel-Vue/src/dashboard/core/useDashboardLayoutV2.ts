import { computed, watch, type ComputedRef } from "vue";
import { useLocalStorage } from "@/composables/useLocalStorage";
import type { DashboardCardContribution, DashboardCardInstance, DashboardLayoutStateV2 } from "@/dashboard/core/types";
import {
  clampDashboardCardSize,
  DASHBOARD_LAYOUT_V2_STORAGE_KEY,
  DASHBOARD_LEGACY_ORDER_STORAGE_KEY,
  DASHBOARD_LEGACY_SIZES_STORAGE_KEY,
  GENERIC_DASHBOARD_CARD_MAX_SIZE,
  GENERIC_DASHBOARD_CARD_MIN_SIZE,
  isPlainObject,
  type DashboardCardSize,
} from "@/dashboard/core/types";

interface LegacyLayoutSnapshot {
  order: string[];
  sizes: Record<string, Partial<DashboardCardSize>>;
}

interface DashboardResolvedLayout {
  instances: DashboardCardInstance[];
  dismissedTypeIds: string[];
}

function serializeLayout(layout: DashboardLayoutStateV2): string {
  return JSON.stringify(layout);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

function generateInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCardInstance(
  contribution: DashboardCardContribution,
  order: number,
  sizeOverride?: Partial<DashboardCardSize>
): DashboardCardInstance {
  return {
    instanceId: generateInstanceId(),
    typeId: contribution.typeId,
    enabled: true,
    order,
    size: clampDashboardCardSize(
      sizeOverride,
      contribution.defaultSize,
      contribution.minSize,
      contribution.maxSize
    ),
    config: {},
  };
}

function normalizeInstanceOrder(instances: readonly DashboardCardInstance[]): DashboardCardInstance[] {
  return [...instances]
    .sort((left, right) => left.order - right.order)
    .map((instance, index) => ({
      ...instance,
      order: index,
    }));
}

function sanitizeGenericInstance(rawInstance: unknown): DashboardCardInstance | null {
  if (!isPlainObject(rawInstance)) {
    return null;
  }

  const instanceId =
    typeof rawInstance.instanceId === "string" && rawInstance.instanceId.trim().length > 0
      ? rawInstance.instanceId
      : generateInstanceId();
  const typeId =
    typeof rawInstance.typeId === "string" && rawInstance.typeId.trim().length > 0
      ? rawInstance.typeId
      : null;

  if (!typeId) {
    return null;
  }

  const fallbackSize: DashboardCardSize = {
    desktopCols: 6,
    tabletCols: 6,
    rows: 16,
  };

  return {
    instanceId,
    typeId,
    enabled: rawInstance.enabled !== false,
    order: typeof rawInstance.order === "number" ? rawInstance.order : 0,
    size: clampDashboardCardSize(
      isPlainObject(rawInstance.size) ? rawInstance.size : undefined,
      fallbackSize,
      GENERIC_DASHBOARD_CARD_MIN_SIZE,
      GENERIC_DASHBOARD_CARD_MAX_SIZE
    ),
    config: isPlainObject(rawInstance.config) ? rawInstance.config : {},
  };
}

function sanitizeStoredLayoutValue(rawLayout: unknown): DashboardLayoutStateV2 | null {
  if (!isPlainObject(rawLayout)) {
    return null;
  }

  const instances = Array.isArray(rawLayout.instances)
    ? rawLayout.instances
        .map((instance) => sanitizeGenericInstance(instance))
        .filter((instance): instance is DashboardCardInstance => instance !== null)
    : [];
  const dismissedTypeIds = Array.isArray(rawLayout.dismissedTypeIds)
    ? uniqueStrings(rawLayout.dismissedTypeIds)
    : [];

  return {
    version: 2,
    instances: normalizeInstanceOrder(instances),
    dismissedTypeIds,
  };
}

function readLegacyLayoutSnapshot(): LegacyLayoutSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const storedOrder = window.localStorage.getItem(DASHBOARD_LEGACY_ORDER_STORAGE_KEY);
    const storedSizes = window.localStorage.getItem(DASHBOARD_LEGACY_SIZES_STORAGE_KEY);
    const parsedOrder = storedOrder ? JSON.parse(storedOrder) : [];
    const parsedSizes = storedSizes ? JSON.parse(storedSizes) : {};

    return {
      order: Array.isArray(parsedOrder)
        ? parsedOrder.filter((item): item is string => typeof item === "string")
        : [],
      sizes: isPlainObject(parsedSizes)
        ? (parsedSizes as Record<string, Partial<DashboardCardSize>>)
        : {},
    };
  } catch {
    return null;
  }
}

function buildDefaultInstances(
  contributions: readonly DashboardCardContribution[],
  dismissedTypeIds: readonly string[]
): DashboardCardInstance[] {
  return contributions
    .filter(
      (contribution) =>
        contribution.defaultEnabled && !dismissedTypeIds.includes(contribution.typeId)
    )
    .map((contribution, index) => createCardInstance(contribution, index));
}

function buildInstancesFromLegacy(
  legacySnapshot: LegacyLayoutSnapshot,
  contributions: readonly DashboardCardContribution[]
): DashboardCardInstance[] {
  const legacyMap = new Map(
    contributions
      .filter((contribution) => contribution.legacyId)
      .map((contribution) => [contribution.legacyId as string, contribution] as const)
  );

  return legacySnapshot.order.flatMap((legacyId, index) => {
    const contribution = legacyMap.get(legacyId);
    if (!contribution) {
      return [];
    }

    return [
      createCardInstance(
        contribution,
        index,
        legacySnapshot.sizes[legacyId]
      ),
    ];
  });
}

function hydrateInstancesWithCatalog(
  instances: readonly DashboardCardInstance[],
  contributions: readonly DashboardCardContribution[]
): DashboardCardInstance[] {
  const contributionMap = new Map(
    contributions.map((contribution) => [contribution.typeId, contribution] as const)
  );
  const seenSingletonTypes = new Set<string>();

  return normalizeInstanceOrder(
    instances.flatMap((instance) => {
      const contribution = contributionMap.get(instance.typeId);
      if (contribution?.singleton) {
        if (seenSingletonTypes.has(instance.typeId)) {
          return [];
        }

        seenSingletonTypes.add(instance.typeId);
      }

      const size = contribution
        ? clampDashboardCardSize(
            instance.size,
            contribution.defaultSize,
            contribution.minSize,
            contribution.maxSize
          )
        : clampDashboardCardSize(
            instance.size,
            instance.size,
            GENERIC_DASHBOARD_CARD_MIN_SIZE,
            GENERIC_DASHBOARD_CARD_MAX_SIZE
          );

      return [
        {
          ...instance,
          size,
          config: isPlainObject(instance.config) ? instance.config : {},
        },
      ];
    })
  );
}

function resolveLayout(
  rawLayout: DashboardLayoutStateV2 | null,
  contributions: readonly DashboardCardContribution[],
  catalogReady: boolean
): DashboardResolvedLayout {
  const storedLayout = sanitizeStoredLayoutValue(rawLayout);
  const dismissedTypeIds = storedLayout?.dismissedTypeIds ?? [];

  let nextInstances = storedLayout?.instances ?? [];

  if (nextInstances.length === 0) {
    if (catalogReady) {
      const legacySnapshot = readLegacyLayoutSnapshot();
      nextInstances =
        legacySnapshot && legacySnapshot.order.length > 0
          ? buildInstancesFromLegacy(legacySnapshot, contributions)
          : buildDefaultInstances(contributions, dismissedTypeIds);
    } else {
      nextInstances = buildDefaultInstances(contributions, dismissedTypeIds);
    }
  }

  const hydratedInstances = hydrateInstancesWithCatalog(nextInstances, contributions);
  const existingTypeIds = new Set(hydratedInstances.map((instance) => instance.typeId));
  const appendedInstances = catalogReady
    ? contributions
        .filter(
          (contribution) =>
            contribution.defaultEnabled &&
            contribution.singleton &&
            !dismissedTypeIds.includes(contribution.typeId) &&
            !existingTypeIds.has(contribution.typeId)
        )
        .map((contribution, index) =>
          createCardInstance(contribution, hydratedInstances.length + index)
        )
    : [];

  return {
    instances: normalizeInstanceOrder([...hydratedInstances, ...appendedInstances]),
    dismissedTypeIds,
  };
}

export function useDashboardLayoutV2(
  contributions: ComputedRef<DashboardCardContribution[]>,
  catalogReady: ComputedRef<boolean>
) {
  const rawLayout = useLocalStorage<DashboardLayoutStateV2 | null>(
    DASHBOARD_LAYOUT_V2_STORAGE_KEY,
    null,
    {
      parser: (value) => sanitizeStoredLayoutValue(JSON.parse(value) as unknown),
      serializer: (value) =>
        value === null
          ? "null"
          : serializeLayout({
              version: 2,
              instances: normalizeInstanceOrder(value.instances),
              dismissedTypeIds: uniqueStrings(value.dismissedTypeIds),
            }),
    }
  );

  const resolvedLayout = computed<DashboardResolvedLayout>(() =>
    resolveLayout(rawLayout.value, contributions.value, catalogReady.value)
  );
  const instances = computed<DashboardCardInstance[]>({
    get: () => resolvedLayout.value.instances,
    set: (nextInstances) => {
      rawLayout.value = {
        version: 2,
        instances: normalizeInstanceOrder(nextInstances),
        dismissedTypeIds: resolvedLayout.value.dismissedTypeIds,
      };
    },
  });

  watch(
    resolvedLayout,
    (nextLayout) => {
      if (!catalogReady.value && rawLayout.value === null) {
        return;
      }

      const normalizedNextLayout: DashboardLayoutStateV2 = {
        version: 2,
        instances: nextLayout.instances,
        dismissedTypeIds: nextLayout.dismissedTypeIds,
      };
      const currentLayout = sanitizeStoredLayoutValue(rawLayout.value);

      if (
        !currentLayout ||
        serializeLayout(currentLayout) !== serializeLayout(normalizedNextLayout)
      ) {
        rawLayout.value = normalizedNextLayout;
      }
    },
    { immediate: true }
  );

  function addCard(typeId: string): string | null {
    const contribution = contributions.value.find((item) => item.typeId === typeId);
    if (!contribution) {
      return null;
    }

    const currentLayout = resolvedLayout.value;
    const existingInstance = currentLayout.instances.find((instance) => instance.typeId === typeId);
    const nextDismissedTypeIds = currentLayout.dismissedTypeIds.filter(
      (dismissedTypeId) => dismissedTypeId !== typeId
    );

    if (contribution.singleton && existingInstance) {
      rawLayout.value = {
        version: 2,
        instances: normalizeInstanceOrder(
          currentLayout.instances.map((instance) =>
            instance.instanceId === existingInstance.instanceId
              ? { ...instance, enabled: true }
              : instance
          )
        ),
        dismissedTypeIds: nextDismissedTypeIds,
      };
      return existingInstance.instanceId;
    }

    const nextInstance = createCardInstance(contribution, currentLayout.instances.length);
    rawLayout.value = {
      version: 2,
      instances: normalizeInstanceOrder([...currentLayout.instances, nextInstance]),
      dismissedTypeIds: nextDismissedTypeIds,
    };
    return nextInstance.instanceId;
  }

  function removeInstance(instanceId: string) {
    const currentLayout = resolvedLayout.value;
    const targetInstance = currentLayout.instances.find(
      (instance) => instance.instanceId === instanceId
    );
    if (!targetInstance) {
      return;
    }

    const contribution = contributions.value.find(
      (item) => item.typeId === targetInstance.typeId
    );
    const nextInstances = currentLayout.instances.filter(
      (instance) => instance.instanceId !== instanceId
    );
    const nextDismissedTypeIds =
      contribution?.singleton === true
        ? uniqueStrings([...currentLayout.dismissedTypeIds, targetInstance.typeId])
        : currentLayout.dismissedTypeIds;

    rawLayout.value = {
      version: 2,
      instances: normalizeInstanceOrder(nextInstances),
      dismissedTypeIds: nextDismissedTypeIds,
    };
  }

  function replaceInstances(nextInstances: readonly DashboardCardInstance[]) {
    rawLayout.value = {
      version: 2,
      instances: normalizeInstanceOrder(
        nextInstances.map((instance, index) => ({
          ...instance,
          order: index,
        }))
      ),
      dismissedTypeIds: resolvedLayout.value.dismissedTypeIds,
    };
  }

  function setInstanceEnabled(instanceId: string, enabled: boolean) {
    rawLayout.value = {
      version: 2,
      instances: normalizeInstanceOrder(
        resolvedLayout.value.instances.map((instance) =>
          instance.instanceId === instanceId ? { ...instance, enabled } : instance
        )
      ),
      dismissedTypeIds: resolvedLayout.value.dismissedTypeIds,
    };
  }

  function setInstanceSize(instanceId: string, size: Partial<DashboardCardSize>) {
    const contribution = contributions.value.find(
      (item) =>
        item.typeId ===
        resolvedLayout.value.instances.find((instance) => instance.instanceId === instanceId)?.typeId
    );

    rawLayout.value = {
      version: 2,
      instances: normalizeInstanceOrder(
        resolvedLayout.value.instances.map((instance) => {
          if (instance.instanceId !== instanceId) {
            return instance;
          }

          return {
            ...instance,
            size: contribution
              ? clampDashboardCardSize(
                  { ...instance.size, ...size },
                  contribution.defaultSize,
                  contribution.minSize,
                  contribution.maxSize
                )
              : clampDashboardCardSize(
                  { ...instance.size, ...size },
                  instance.size,
                  GENERIC_DASHBOARD_CARD_MIN_SIZE,
                  GENERIC_DASHBOARD_CARD_MAX_SIZE
                ),
          };
        })
      ),
      dismissedTypeIds: resolvedLayout.value.dismissedTypeIds,
    };
  }

  function resetLayout() {
    rawLayout.value = {
      version: 2,
      instances: buildDefaultInstances(contributions.value, []),
      dismissedTypeIds: [],
    };
  }

  return {
    instances,
    dismissedTypeIds: computed(() => resolvedLayout.value.dismissedTypeIds),
    addCard,
    removeInstance,
    replaceInstances,
    resetLayout,
    setInstanceEnabled,
    setInstanceSize,
  };
}
