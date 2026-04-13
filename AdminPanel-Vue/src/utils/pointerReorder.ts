export type PointerDropPlacement = 'before' | 'after'

export function getVerticalDropPlacement(
  element: HTMLElement,
  clientY: number
): PointerDropPlacement {
  const rect = element.getBoundingClientRect()
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

export function reorderIdsByPlacement(
  source: readonly string[],
  draggedId: string,
  targetId: string,
  placement: PointerDropPlacement
): string[] {
  const fromIndex = source.indexOf(draggedId)
  const targetIndex = source.indexOf(targetId)
  if (fromIndex < 0 || targetIndex < 0) {
    return [...source]
  }

  const insertionIndex = placement === 'after' ? targetIndex + 1 : targetIndex
  const normalizedToIndex = insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex
  if (normalizedToIndex === fromIndex) {
    return [...source]
  }

  const next = [...source]
  const [movedItem] = next.splice(fromIndex, 1)
  next.splice(normalizedToIndex, 0, movedItem)
  return next
}
