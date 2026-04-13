import type { Router } from "vue-router";
import { getAppRoutePath } from "@/app/routes/manifest";

export function resolveSafeAppRedirect(
  router: Router,
  target: unknown,
  fallbackRouteId: "dashboard" | "login" = "dashboard"
): string {
  const fallbackPath = getAppRoutePath(fallbackRouteId);

  if (typeof target !== "string" || !target.startsWith("/")) {
    return fallbackPath;
  }

  const resolved = router.resolve(target);
  if (!resolved.matched.length || resolved.name === "Login") {
    return fallbackPath;
  }

  return resolved.fullPath.startsWith("/") ? resolved.fullPath : fallbackPath;
}
