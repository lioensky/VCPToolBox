export interface Placeholder {
  name: string
  type: string
  preview: string
  content?: string
  charCount?: number
  description?: string
}

export type PlaceholderViewMode = 'grouped' | 'list'
export type PlaceholderDetailTab = 'raw' | 'markdown' | 'json'

export interface PlaceholderTypeOption {
  value: string
  label: string
  count: number
}
