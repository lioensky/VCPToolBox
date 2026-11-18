import type { LocationQuery, LocationQueryValue } from "vue-router";

export interface EmojiGalleryRouteState {
  readonly keyword: string;
  readonly category: string;
  readonly page: number;
  readonly pageSize: number;
}

interface ReadRouteStateOptions {
  readonly defaultPageSize: number;
  readonly pageSizeOptions: readonly number[];
}

function getSingleQueryValue(value: LocationQueryValue | LocationQueryValue[] | undefined): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }

  return typeof value === "string" ? value : "";
}

function parsePositiveInt(rawValue: string, fallback: number): number {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function readEmojiGalleryRouteState(
  query: LocationQuery,
  options: ReadRouteStateOptions
): EmojiGalleryRouteState {
  const keyword = getSingleQueryValue(query.keyword).trim();
  const category = getSingleQueryValue(query.category).trim();
  const page = parsePositiveInt(getSingleQueryValue(query.page), 1);
  const requestedPageSize = parsePositiveInt(
    getSingleQueryValue(query.pageSize),
    options.defaultPageSize
  );
  const allowedPageSizes = new Set(options.pageSizeOptions);
  const pageSize = allowedPageSizes.has(requestedPageSize)
    ? requestedPageSize
    : options.defaultPageSize;

  return {
    keyword,
    category,
    page,
    pageSize,
  };
}

export function buildEmojiGalleryRouteQuery(
  state: EmojiGalleryRouteState,
  defaults: Pick<EmojiGalleryRouteState, "page" | "pageSize">
): Record<string, string | undefined> {
  return {
    keyword: state.keyword || undefined,
    category: state.category || undefined,
    page: state.page > defaults.page ? String(state.page) : undefined,
    pageSize:
      state.pageSize !== defaults.pageSize ? String(state.pageSize) : undefined,
  };
}
