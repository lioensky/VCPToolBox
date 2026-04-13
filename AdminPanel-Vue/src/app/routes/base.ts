export const APP_ROUTER_BASE = "/AdminPanel";
export const APP_LEGACY_ROUTER_BASE = "/AdminPanelLegacy";

interface AppLocationLike {
  pathname: string;
  search?: string;
  hash?: string;
}

function hasBasePrefix(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

export function normalizeLegacyAppPath(pathname: string): string {
  if (!hasBasePrefix(pathname, APP_LEGACY_ROUTER_BASE)) {
    return pathname;
  }

  const suffix = pathname.slice(APP_LEGACY_ROUTER_BASE.length);
  if (!suffix || suffix === "/") {
    return APP_ROUTER_BASE;
  }

  if (!suffix.startsWith("/")) {
    return `${APP_ROUTER_BASE}/${suffix}`;
  }

  return `${APP_ROUTER_BASE}${suffix}`;
}

export function resolveCanonicalAppLocation(location: AppLocationLike): string | null {
  if (!hasBasePrefix(location.pathname, APP_LEGACY_ROUTER_BASE)) {
    return null;
  }

  const normalizedPathname = normalizeLegacyAppPath(location.pathname);
  const search = location.search ?? "";
  const hash = location.hash ?? "";
  return `${normalizedPathname}${search}${hash}`;
}

export function stripAppRouterBase(path: string): string {
  if (!path.startsWith(APP_ROUTER_BASE)) {
    return path;
  }

  const nextPath = path.slice(APP_ROUTER_BASE.length);
  if (!nextPath.startsWith("/")) {
    return `/${nextPath}`;
  }

  return nextPath || "/";
}
