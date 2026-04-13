import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMainLayoutControls } from "@/composables/main-layout/useMainLayoutControls";
import { useMainLayoutDomEffects } from "@/composables/main-layout/useMainLayoutDomEffects";
import { useMainLayoutNavigation } from "@/composables/main-layout/useMainLayoutNavigation";
import { useAppStore } from "@/stores/app";

export function useMainLayoutState() {
  const router = useRouter();
  const route = useRoute();
  const appStore = useAppStore();
  const controls = useMainLayoutControls();
  const contentRef = ref<HTMLElement | null>(null);

  const navigation = useMainLayoutNavigation({
    router,
    route,
    appStore,
    closeTransientUi: controls.closeTransientUi,
  });
  const domEffects = useMainLayoutDomEffects({
    route,
    appStore,
    contentRef,
    controls,
  });

  return {
    ...controls,
    ...navigation,
    ...domEffects,
    contentRef,
  };
}
