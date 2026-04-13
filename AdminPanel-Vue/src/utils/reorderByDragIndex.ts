export interface ReorderResult<T> {
  items: T[]
  moved: boolean
}

export function reorderByDragIndex<T>(
  source: readonly T[],
  fromIndex: number,
  toIndex: number
): ReorderResult<T> {
  const length = source.length
  if (
    fromIndex < 0 ||
    fromIndex >= length ||
    toIndex < 0 ||
    toIndex > length
  ) {
    return { items: [...source], moved: false }
  }

  if (length <= 1) {
    return { items: [...source], moved: false }
  }

  const normalizedToIndex = toIndex > fromIndex ? toIndex - 1 : toIndex
  if (normalizedToIndex === fromIndex) {
    return { items: [...source], moved: false }
  }

  const items = [...source]
  const [movedItem] = items.splice(fromIndex, 1)
  items.splice(normalizedToIndex, 0, movedItem)

  return { items, moved: true }
}
