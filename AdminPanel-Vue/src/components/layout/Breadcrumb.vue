<template>
  <nav class="breadcrumb" aria-label="面包屑导航">
    <ol>
      <li>
        <a href="#" @click.prevent="goToDashboard" aria-label="返回首页">
          <span class="material-symbols-outlined">home</span>
        </a>
      </li>

      <!-- 多级面包屑：导航分组 > 当前页面 -->
      <template v-for="(crumb, index) in breadcrumbs" :key="crumb.title">
        <li class="breadcrumb-separator">
          <span class="material-symbols-outlined">chevron_right</span>
        </li>
        <li v-if="index < breadcrumbs.length - 1">
          <a href="#" @click.prevent="navigateTo(crumb.route)">
            {{ crumb.title }}
          </a>
        </li>
        <li
          v-else
          class="breadcrumb-current"
          aria-current="page"
        >
          {{ crumb.title }}
        </li>
      </template>
    </ol>
  </nav>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter, type RouteLocationRaw } from "vue-router";
import {
  resolveAppRouteTitle,
  getAppRouteMetaByRouteName,
  type AppRouteGroup,
} from "@/app/routes/manifest";
import { useAppStore } from "@/stores/app";

interface BreadcrumbItem {
  title: string;
  route: RouteLocationRaw;
}

const router = useRouter();
const route = useRoute();
const appStore = useAppStore();

const navItems = computed(() => appStore.navItems);
const plugins = computed(() => appStore.plugins);

const currentPageTitle = computed(() =>
  resolveAppRouteTitle(route, {
    navItems: navItems.value,
    plugins: plugins.value,
  })
);

const currentNavGroup = computed<AppRouteGroup | undefined>(() => {
  const namedRoute = getAppRouteMetaByRouteName(route.name);
  // navGroup 只存在于 manifest 定义中，需要类型守卫
  if (namedRoute && "navGroup" in namedRoute) {
    return (namedRoute as { navGroup?: AppRouteGroup }).navGroup;
  }
  return undefined;
});

// 导航分组标签映射（本地定义，因为 manifest 未导出）
const NAV_GROUP_LABELS: Record<AppRouteGroup, string> = {
  core: "核心功能",
  agent: "Agent 相关",
  tools: "工具相关",
  rag: "RAG 相关",
  plugins: "插件中心",
  other: "其他",
};

const breadcrumbs = computed<BreadcrumbItem[]>(() => {
  const crumbs: BreadcrumbItem[] = [];

  // 第一级：导航分组（如果有）
  if (currentNavGroup.value) {
    const groupLabel = NAV_GROUP_LABELS[currentNavGroup.value];

    // 导航分组没有独立页面，只显示文本
    crumbs.push({
      title: groupLabel,
      route: { name: "Dashboard" }, // 分组没有独立路由，指向首页
    });
  }

  // 最后一级：当前页面
  if (currentPageTitle.value) {
    crumbs.push({
      title: currentPageTitle.value,
      route: route.fullPath,
    });
  }

  return crumbs;
});

function goToDashboard() {
  router.push({ name: "Dashboard" });
}

function navigateTo(location: RouteLocationRaw) {
  router.push(location);
}
</script>

<style scoped>
.breadcrumb {
  margin-bottom: 20px;
}

.breadcrumb ol {
  display: flex;
  align-items: center;
  list-style: none;
  padding: 0;
  margin: 0;
  gap: 8px;
  flex-wrap: wrap;
}

.breadcrumb li {
  display: flex;
  align-items: center;
}

.breadcrumb a {
  display: flex;
  align-items: center;
  color: var(--secondary-text);
  text-decoration: none;
  padding: 6px 10px;
  border-radius: 6px;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.breadcrumb a:hover {
  background-color: var(--accent-bg);
  color: var(--primary-text);
}

.breadcrumb-separator {
  color: var(--secondary-text);
  display: flex;
  align-items: center;
  padding: 0 2px;
}

.breadcrumb-separator .material-symbols-outlined {
  font-size: var(--font-size-emphasis);
}

.breadcrumb-current {
  color: var(--primary-text);
  font-weight: 500;
  padding: 6px 10px;
  background-color: var(--accent-bg);
  border-radius: 6px;
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .breadcrumb {
    margin-bottom: 16px;
  }

  .breadcrumb ol {
    gap: 6px;
    min-width: 0;
  }

  .breadcrumb li {
    min-width: 0;
  }

  .breadcrumb a {
    padding: 6px 8px;
  }

  .breadcrumb-current {
    max-width: 200px;
  }
}
</style>
