import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from "vue-router";
import {
  APP_DEFAULT_ROUTE_ID,
  APP_ROUTE_MANIFEST,
  getAppRouteMetaById,
} from "@/app/routes/manifest";
import { APP_ROUTER_BASE, resolveCanonicalAppLocation } from "@/app/routes/base";
import { resolveSafeAppRedirect } from "@/app/routes/redirect";
import { useAuthStore } from "@/stores/auth";
import { createLogger } from "@/utils/logger";
const logger = createLogger("Router");

if (typeof window !== "undefined") {
  const canonicalLocation = resolveCanonicalAppLocation(window.location);
  if (canonicalLocation) {
    window.history.replaceState(window.history.state, "", canonicalLocation);
  }
}

const loginRoute = getAppRouteMetaById("login");
const defaultRoute = getAppRouteMetaById(APP_DEFAULT_ROUTE_ID);

const shellRoutes: RouteRecordRaw[] = APP_ROUTE_MANIFEST.filter(
  (route) => route.id !== "login"
).map((route) => ({
  path: route.path.replace(/^\//, ""),
  name: route.routeName,
  component: route.component,
  meta: { requiresAuth: route.requiresAuth },
}));

const routes: RouteRecordRaw[] = [
  {
    path: loginRoute.path,
    name: loginRoute.routeName,
    component: loginRoute.component,
    meta: { requiresAuth: loginRoute.requiresAuth },
  },
  {
    path: "/",
    name: "Main",
    component: () => import("@/layouts/MainLayout.vue"),
    redirect: defaultRoute.path,
    children: shellRoutes,
  },
];

const router = createRouter({
  history: createWebHistory(APP_ROUTER_BASE),
  routes,
});

function isPublicRoute(to: {
  name?: string | symbol | null;
  meta: Record<string, unknown>;
}): boolean {
  return to.meta.requiresAuth === false || to.name === "Login";
}

function getSafeRedirectTarget(to: { fullPath: string }): string {
  return resolveSafeAppRedirect(router, to.fullPath, "dashboard");
}

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore();

  try {
    if (isPublicRoute(to)) {
      // 已登录用户访问登录页时跳转到目标页或首页
      if (to.name === "Login") {
        const isAuthenticated =
          authStore.isAuthenticated || (await authStore.checkAuth());
        if (isAuthenticated) {
          const redirect = resolveSafeAppRedirect(
            router,
            typeof to.query.redirect === "string" ? to.query.redirect : null
          );
          next(redirect);
          return;
        }
      }

      next();
      return;
    }

    const isAuthenticated =
      authStore.isAuthenticated || (await authStore.checkAuth());
    if (!isAuthenticated) {
      next({
        name: "Login",
        query: {
          redirect: getSafeRedirectTarget(to),
        },
      });
      return;
    }

    next();
  } catch (error) {
    logger.error("Navigation guard error:", error);

    // 异常时允许公开页继续访问，受保护页回退到登录页
    if (isPublicRoute(to)) {
      next();
      return;
    }

    next({
      name: "Login",
      query: {
        redirect: getSafeRedirectTarget(to),
      },
    });
  }
});

export default router;
