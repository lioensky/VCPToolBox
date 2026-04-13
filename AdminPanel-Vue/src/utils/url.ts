const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"])

export function sanitizeExternalUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== "string") {
    return null
  }

  try {
    const url = new URL(rawUrl)
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export function isSafeExternalUrl(rawUrl: string | null | undefined): boolean {
  return sanitizeExternalUrl(rawUrl) !== null
}
