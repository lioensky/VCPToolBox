import type { FinalContextBlockSummary } from '@/types/api.system'

export type MoonlightRole = 'system' | 'user' | 'assistant' | 'tool' | string

export interface MoonlightOptions {
  topStopwordCount: number
  minTermLength: number
  useCharBigrams: boolean
  useCharTrigrams: boolean
  keepNumbers: boolean
  keepIdentifiers: boolean
  k1: number
  b: number
}

export interface MoonlightIndexedBlock {
  index: number
  role: MoonlightRole
  displayRole: MoonlightRole
  text: string
  sanitizedText: string
  terms: string[]
  termFreq: Map<string, number>
  length: number
  excluded?: boolean
  excludeReason?: string
}

export interface MoonlightTermStat {
  term: string
  queryFrequency: number
  documentFrequency: number
  idf: number
  corpusFrequency: number
  isNumeric: boolean
  isIdentifier: boolean
}

export interface MoonlightBlockScore {
  blockIndex: number
  role: MoonlightRole
  displayRole: MoonlightRole
  rawScore: number
  weightedScore: number
  normalizedScore: number
  normalizedWeightedScore: number
  typeWeight: number
  positionWeight: number
  matchedTerms: MoonlightTermStat[]
  matchedTermCount: number
  sanitizedLength: number
  textPreview: string
}

export interface MoonlightDomainSummary {
  rawScore: number
  weightedScore: number
  blockCount: number
  matchedBlockCount: number
}

export interface MoonlightLinearSegment {
  blockIndex: number
  role: MoonlightRole
  displayRole: MoonlightRole
  startRatio: number
  endRatio: number
  widthRatio: number
  rawScore: number
  weightedScore: number
  normalizedWeightedScore: number
  sanitizedLength: number
  matchedTermCount: number
  textPreview: string
}

export interface MoonlightCurvePoint {
  blockIndex: number
  role: MoonlightRole
  displayRole: MoonlightRole
  x: number
  y: number
  normalizedWeightedScore: number
  weightedScore: number
  rawScore: number
  matchedTermCount: number
  sanitizedLength: number
  isPeak: boolean
  isValley: boolean
  textPreview: string
}

export interface MoonlightReport {
  selectedBlockIndex: number
  selectedTextPreview: string
  options: MoonlightOptions
  query: {
    rawLength: number
    sanitizedLength: number
    rawTermCount: number
    retainedTermCount: number
    uniqueRetainedTermCount: number
    removedHighFrequencyTerms: MoonlightTermStat[]
    topQueryTerms: MoonlightTermStat[]
    numericTerms: MoonlightTermStat[]
    identifierTerms: MoonlightTermStat[]
    zeroHitTerms: MoonlightTermStat[]
  }
  corpus: {
    totalPreviousBlocks: number
    indexedBlocks: number
    excludedBlocks: Array<{ index: number; role: string; reason: string }>
    averageDocumentLength: number
    documentFrequency: Record<string, number>
  }
  scores: MoonlightBlockScore[]
  systemScores: MoonlightBlockScore[]
  linearSegments: MoonlightLinearSegment[]
  curvePoints: MoonlightCurvePoint[]
  domainSummary: Record<string, MoonlightDomainSummary>
  metrics: {
    coverage: number
    weightedCoverage: number
    gapMax: number
    edgeBias: number
    midVoid: number
    selfEchoRatio: number
    externalSupportRatio: number
    systemSupportRatio: number
    recentUserSupportRatio: number
    contextAttentionProxy: number
    systemAdherenceProxy: number
    selfEchoRisk: number
    hollowSummaryRisk: number
  }
  labels: string[]
}

const DEFAULT_OPTIONS: MoonlightOptions = {
  topStopwordCount: 30,
  minTermLength: 2,
  useCharBigrams: true,
  useCharTrigrams: false,
  keepNumbers: true,
  keepIdentifiers: true,
  k1: 1.5,
  b: 0.75,
}

const BUILTIN_STOPWORDS = new Set([
  '的',
  '了',
  '和',
  '是',
  '在',
  '就',
  '都',
  '而',
  '及',
  '与',
  '或',
  '一个',
  '没有',
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '这些',
  '那些',
  '因为',
  '所以',
  '但是',
  '如果',
  '然后',
  '以及',
  '进行',
  '可以',
  '需要',
  '不是',
  '就是',
  '还是',
  '已经',
  '通过',
  '对于',
  '关于',
  '作为',
  'the',
  'and',
  'or',
  'to',
  'of',
  'in',
  'is',
  'are',
  'a',
  'an',
  'for',
  'with',
  'on',
  'as',
  'by',
  'this',
  'that',
])

export function getDefaultMoonlightOptions(): MoonlightOptions {
  return { ...DEFAULT_OPTIONS }
}

export function stripHtml(html: string): string {
  if (!html) return ''
  if (typeof html !== 'string') return String(html)

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<section>${html}</section>`, 'text/html')
    doc.querySelectorAll('style, script, noscript, template').forEach((node) => node.remove())
    return (doc.body.textContent || '')
      .replace(/^[ \t]+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return html
  }
}

export function stripEmoji(text: string): string {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/\u{200D}/gu, '')
    .trim()
}

export function stripToolMarkers(text: string): string {
  if (!text || typeof text !== 'string') return ''

  const processed = text.replace(
    /<<<\[?TOOL_REQUEST\]?>>>([\s\S]*?)<<<\[?END_TOOL_REQUEST\]?>>>/gi,
    (_match, block: string) => {
      const blacklistedKeys = ['tool_name', 'command', 'archery', 'maid']
      const blacklistedValues = ['dailynote', 'update', 'create', 'no_reply']
      const results: string[] = []
      const regex = /(\w+):\s*[「『]始[」』]([\s\S]*?)[「『]末[」』]/g
      let match: RegExpExecArray | null

      while ((match = regex.exec(block)) !== null) {
        const key = match[1].toLowerCase()
        const value = match[2].trim()
        const valueLower = value.toLowerCase()
        const isTechKey = blacklistedKeys.includes(key)
        const isTechValue = blacklistedValues.some((item) => valueLower.includes(item))

        if (!isTechKey && !isTechValue && value.length > 1) {
          results.push(value)
        }
      }

      if (results.length > 0) return results.join('\n')

      return block
        .split('\n')
        .map((line) => {
          const cleanLine = line
            .replace(/\w+:\s*[「『]始[」』]/g, '')
            .replace(/[「『]末[」』]/g, '')
            .trim()
          const lower = cleanLine.toLowerCase()
          return blacklistedValues.some((item) => lower.includes(item)) ? '' : cleanLine
        })
        .filter(Boolean)
        .join('\n')
    }
  )

  return processed
    .replace(/<<<\[?TOOL_REQUEST\]?>>>/gi, '')
    .replace(/<<<\[?END_TOOL_REQUEST\]?>>>/gi, '')
    .replace(/[「」『』]始[「」『』]/g, '')
    .replace(/[「」『』]末[「」『』]/g, '')
    .replace(/[「」『』]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function stripSystemNotification(text: string): string {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/\[系统通知\][\s\S]*?\[系统通知结束\]/g, '')
    .replace(/^\s*\[系统通知[:：]?[\s\S]*$/gm, '')
    .trim()
}

export function stripOneRingMarkers(text: string): string {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/\[OneRing通知:[\s\S]*?于\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?发送于[^\]]*?\]/g, '')
    .replace(/^\s*\[系统提示:\]\[OneRing通知:[\s\S]*?\]\s*$/gm, '')
    .replace(/\[OneRing[^\]]*?\]/g, '')
    .trim()
}

export function sanitizeMoonlightText(content: string, role: MoonlightRole): string {
  if (!content || typeof content !== 'string') return ''

  let processed = content
  if (role === 'user') {
    processed = stripSystemNotification(processed)
  }

  processed = stripOneRingMarkers(processed)
  processed = stripHtml(processed)
  processed = stripEmoji(processed)
  processed = stripToolMarkers(processed)

  return processed
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function shouldExcludeMoonlightBlock(block: FinalContextBlockSummary): string | null {
  const text = String(block.text || '').trim()
  if (!text) return '空文本块'
  if (block.role === 'user' && /^\[系统提示/.test(text)) return '伪 system user 块'
  if (/^\[系统提示:\]\[OneRing通知:上一条消息由/.test(text)) return 'OneRing 分离来源注入块'
  if (/^\[OneRing通知:[\s\S]*?\]$/.test(text)) return 'OneRing 纯来源尾部块'
  return null
}

export function tokenizeMoonlightText(text: string, options: MoonlightOptions = DEFAULT_OPTIONS): string[] {
  const normalized = String(text || '').toLowerCase()
  const terms: string[] = []

  if (options.keepIdentifiers) {
    const identifiers = normalized.match(/[a-z_][a-z0-9_.:/@#-]{1,}/g) || []
    terms.push(...identifiers)
  }

  if (options.keepNumbers) {
    const numbers = normalized.match(/\b\d+(?:\.\d+)*(?:[a-z%]+)?\b/g) || []
    terms.push(...numbers)
  }

  const cjkRuns = normalized.match(/[\u4e00-\u9fff]{2,}/g) || []
  for (const run of cjkRuns) {
    if (run.length >= options.minTermLength && !BUILTIN_STOPWORDS.has(run)) {
      terms.push(run)
    }
    if (options.useCharBigrams) {
      for (let index = 0; index <= run.length - 2; index += 1) {
        terms.push(run.slice(index, index + 2))
      }
    }
    if (options.useCharTrigrams) {
      for (let index = 0; index <= run.length - 3; index += 1) {
        terms.push(run.slice(index, index + 3))
      }
    }
  }

  const mixedWords = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) || []
  for (const word of mixedWords) {
    if (word.length >= options.minTermLength && !BUILTIN_STOPWORDS.has(word)) {
      terms.push(word)
    }
  }

  return terms.filter((term) => term.length >= options.minTermLength && !BUILTIN_STOPWORDS.has(term))
}

export function runMoonlightAnalysis(
  blocks: FinalContextBlockSummary[],
  selectedBlock: FinalContextBlockSummary,
  optionsInput: Partial<MoonlightOptions> = {},
  getDisplayRole: (block: FinalContextBlockSummary) => string = (block) => block.role
): MoonlightReport {
  const options = { ...DEFAULT_OPTIONS, ...optionsInput }
  const selectedIndex = selectedBlock.index
  const previousBlocks = blocks.filter((block) => block.index < selectedIndex)
  const excludedBlocks: Array<{ index: number; role: string; reason: string }> = []

  const indexedBlocks: MoonlightIndexedBlock[] = previousBlocks
    .map((block) => {
      const displayRole = getDisplayRole(block)
      const excludeReason = shouldExcludeMoonlightBlock(block)
      const sanitizedText = sanitizeMoonlightText(block.text, displayRole)
      if (excludeReason || !sanitizedText) {
        excludedBlocks.push({
          index: block.index,
          role: displayRole,
          reason: excludeReason || '净化后为空',
        })
      }

      const terms = tokenizeMoonlightText(sanitizedText, options)
      return {
        index: block.index,
        role: block.role,
        displayRole,
        text: block.text,
        sanitizedText,
        terms,
        termFreq: buildTermFrequency(terms),
        length: terms.length,
        excluded: Boolean(excludeReason || !sanitizedText),
        excludeReason: excludeReason || undefined,
      }
    })
    .filter((block) => !block.excluded)

  const selectedDisplayRole = getDisplayRole(selectedBlock)
  const selectedSanitizedText = sanitizeMoonlightText(selectedBlock.text, selectedDisplayRole)
  const rawQueryTerms = tokenizeMoonlightText(selectedSanitizedText, options)
  const corpusFrequency = buildCorpusFrequency(indexedBlocks)
  const documentFrequency = buildDocumentFrequency(indexedBlocks)
  const removedHighFrequencySet = new Set(
    [...corpusFrequency.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(0, options.topStopwordCount))
      .map(([term]) => term)
  )
  const retainedQueryTerms = rawQueryTerms.filter((term) => !removedHighFrequencySet.has(term))
  const queryFrequency = buildTermFrequency(retainedQueryTerms)
  const averageDocumentLength = indexedBlocks.length > 0
    ? indexedBlocks.reduce((sum, block) => sum + block.length, 0) / indexedBlocks.length
    : 0
  const queryTermStats = [...queryFrequency.entries()].map(([term, frequency]) => buildTermStat(
    term,
    frequency,
    documentFrequency.get(term) || 0,
    corpusFrequency.get(term) || 0,
    indexedBlocks.length
  ))

  const scores = indexedBlocks.map((block) => scoreBlock(
    block,
    queryTermStats,
    documentFrequency,
    indexedBlocks.length,
    averageDocumentLength,
    selectedIndex,
    options
  ))

  normalizeScores(scores)
  const systemScores = scores.filter((score) => score.displayRole === 'system')
  const linearSegments = buildLinearSegments(indexedBlocks, scores)
  const curvePoints = buildCurvePoints(linearSegments)
  const domainSummary = summarizeDomains(scores)
  const metrics = computeMetrics(scores, selectedBlock, retainedQueryTerms, systemScores)
  const labels = buildLabels(metrics, selectedBlock, scores)

  return {
    selectedBlockIndex: selectedIndex,
    selectedTextPreview: createPreview(selectedSanitizedText),
    options,
    query: {
      rawLength: String(selectedBlock.text || '').length,
      sanitizedLength: selectedSanitizedText.length,
      rawTermCount: rawQueryTerms.length,
      retainedTermCount: retainedQueryTerms.length,
      uniqueRetainedTermCount: queryFrequency.size,
      removedHighFrequencyTerms: [...removedHighFrequencySet]
        .map((term) => buildTermStat(term, rawQueryTerms.filter((item) => item === term).length, documentFrequency.get(term) || 0, corpusFrequency.get(term) || 0, indexedBlocks.length))
        .filter((stat) => stat.queryFrequency > 0 || stat.corpusFrequency > 0)
        .slice(0, options.topStopwordCount),
      topQueryTerms: queryTermStats
        .sort((a, b) => (b.idf * b.queryFrequency) - (a.idf * a.queryFrequency))
        .slice(0, 24),
      numericTerms: queryTermStats.filter((term) => term.isNumeric).slice(0, 24),
      identifierTerms: queryTermStats.filter((term) => term.isIdentifier).slice(0, 24),
      zeroHitTerms: queryTermStats.filter((term) => term.documentFrequency === 0).slice(0, 24),
    },
    corpus: {
      totalPreviousBlocks: previousBlocks.length,
      indexedBlocks: indexedBlocks.length,
      excludedBlocks,
      averageDocumentLength,
      documentFrequency: Object.fromEntries(documentFrequency.entries()),
    },
    scores: scores.sort((a, b) => a.blockIndex - b.blockIndex),
    systemScores,
    linearSegments,
    curvePoints,
    domainSummary,
    metrics,
    labels,
  }
}

function buildTermFrequency(terms: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const term of terms) {
    map.set(term, (map.get(term) || 0) + 1)
  }
  return map
}

function buildCorpusFrequency(blocks: MoonlightIndexedBlock[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const block of blocks) {
    for (const term of block.terms) {
      map.set(term, (map.get(term) || 0) + 1)
    }
  }
  return map
}

function buildDocumentFrequency(blocks: MoonlightIndexedBlock[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const block of blocks) {
    const uniqueTerms = new Set(block.terms)
    for (const term of uniqueTerms) {
      map.set(term, (map.get(term) || 0) + 1)
    }
  }
  return map
}

function buildTermStat(
  term: string,
  queryFrequency: number,
  documentFrequency: number,
  corpusFrequency: number,
  documentCount: number
): MoonlightTermStat {
  return {
    term,
    queryFrequency,
    documentFrequency,
    corpusFrequency,
    idf: calculateIdf(documentCount, documentFrequency),
    isNumeric: /^\d+(?:\.\d+)*(?:[a-z%]+)?$/.test(term),
    isIdentifier: /[a-z_][a-z0-9_.:/@#-]{1,}/.test(term),
  }
}

function calculateIdf(documentCount: number, documentFrequency: number): number {
  if (documentCount <= 0) return 0
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
}

function scoreBlock(
  block: MoonlightIndexedBlock,
  queryTermStats: MoonlightTermStat[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageDocumentLength: number,
  selectedIndex: number,
  options: MoonlightOptions
): MoonlightBlockScore {
  let rawScore = 0
  const matchedTerms: MoonlightTermStat[] = []
  const blockLength = Math.max(1, block.length)
  const avgdl = Math.max(1, averageDocumentLength)

  for (const stat of queryTermStats) {
    const frequency = block.termFreq.get(stat.term) || 0
    if (frequency <= 0) continue

    const idf = calculateIdf(documentCount, documentFrequency.get(stat.term) || 0)
    const numerator = frequency * (options.k1 + 1)
    const denominator = frequency + options.k1 * (1 - options.b + options.b * (blockLength / avgdl))
    rawScore += idf * (numerator / denominator) * Math.sqrt(stat.queryFrequency)
    matchedTerms.push(stat)
  }

  const typeWeight = getTypeWeight(block.displayRole, selectedIndex - block.index)
  const positionWeight = getPositionWeight(selectedIndex - block.index)
  const weightedScore = rawScore * typeWeight * positionWeight

  return {
    blockIndex: block.index,
    role: block.role,
    displayRole: block.displayRole,
    rawScore,
    weightedScore,
    normalizedScore: 0,
    normalizedWeightedScore: 0,
    typeWeight,
    positionWeight,
    matchedTerms: matchedTerms
      .sort((a, b) => (b.idf * b.queryFrequency) - (a.idf * a.queryFrequency))
      .slice(0, 12),
    matchedTermCount: matchedTerms.length,
    sanitizedLength: block.sanitizedText.length,
    textPreview: createPreview(block.sanitizedText),
  }
}

function getTypeWeight(role: string, distance: number): number {
  if (role === 'tool') return 1.05
  if (role === 'system') return 0.75
  if (role === 'assistant') return 0.32
  if (role === 'user') return distance <= 2 ? 1 : 0.62
  return 0.5
}

function getPositionWeight(distance: number): number {
  if (distance <= 1) return 1
  if (distance <= 3) return 0.92
  if (distance <= 8) return 0.78
  if (distance <= 20) return 0.58
  return 0.42
}

function normalizeScores(scores: MoonlightBlockScore[]): void {
  const maxRaw = Math.max(0, ...scores.map((score) => score.rawScore))
  const maxWeighted = Math.max(0, ...scores.map((score) => score.weightedScore))
  for (const score of scores) {
    score.normalizedScore = maxRaw > 0 ? score.rawScore / maxRaw : 0
    score.normalizedWeightedScore = maxWeighted > 0 ? score.weightedScore / maxWeighted : 0
  }
}

function buildLinearSegments(
  indexedBlocks: MoonlightIndexedBlock[],
  scores: MoonlightBlockScore[]
): MoonlightLinearSegment[] {
  const scoreMap = new Map(scores.map((score) => [score.blockIndex, score]))
  const totalLength = indexedBlocks.reduce((sum, block) => sum + Math.max(1, block.sanitizedText.length), 0)
  let cursor = 0

  return indexedBlocks.map((block) => {
    const length = Math.max(1, block.sanitizedText.length)
    const startRatio = totalLength > 0 ? cursor / totalLength : 0
    cursor += length
    const endRatio = totalLength > 0 ? cursor / totalLength : 1
    const score = scoreMap.get(block.index)

    return {
      blockIndex: block.index,
      role: block.role,
      displayRole: block.displayRole,
      startRatio,
      endRatio,
      widthRatio: Math.max(0.002, endRatio - startRatio),
      rawScore: score?.rawScore ?? 0,
      weightedScore: score?.weightedScore ?? 0,
      normalizedWeightedScore: score?.normalizedWeightedScore ?? 0,
      sanitizedLength: block.sanitizedText.length,
      matchedTermCount: score?.matchedTermCount ?? 0,
      textPreview: createPreview(block.sanitizedText),
    }
  })
}

function buildCurvePoints(segments: MoonlightLinearSegment[]): MoonlightCurvePoint[] {
  const points = segments.map((segment) => ({
    blockIndex: segment.blockIndex,
    role: segment.role,
    displayRole: segment.displayRole,
    x: clamp01((segment.startRatio + segment.endRatio) / 2),
    y: clamp01(segment.normalizedWeightedScore),
    normalizedWeightedScore: segment.normalizedWeightedScore,
    weightedScore: segment.weightedScore,
    rawScore: segment.rawScore,
    matchedTermCount: segment.matchedTermCount,
    sanitizedLength: segment.sanitizedLength,
    isPeak: false,
    isValley: false,
    textPreview: segment.textPreview,
  }))

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const next = points[index + 1]
    if (!previous || !next) continue

    const isStrictPeak = current.y > previous.y && current.y >= next.y
    const isStrictValley = current.y < previous.y && current.y <= next.y
    const hasMeaningfulPeak = current.y >= 0.12 && (current.y - Math.max(previous.y, next.y)) >= 0.04
    const hasMeaningfulValley = Math.max(previous.y, next.y) >= 0.18 && (Math.min(previous.y, next.y) - current.y) >= 0.04

    current.isPeak = isStrictPeak && hasMeaningfulPeak
    current.isValley = isStrictValley && hasMeaningfulValley
  }

  return points
}

function summarizeDomains(scores: MoonlightBlockScore[]): Record<string, MoonlightDomainSummary> {
  const summary: Record<string, MoonlightDomainSummary> = {}
  for (const score of scores) {
    const key = String(score.displayRole || 'unknown')
    if (!summary[key]) {
      summary[key] = {
        rawScore: 0,
        weightedScore: 0,
        blockCount: 0,
        matchedBlockCount: 0,
      }
    }
    summary[key].rawScore += score.rawScore
    summary[key].weightedScore += score.weightedScore
    summary[key].blockCount += 1
    if (score.rawScore > 0) summary[key].matchedBlockCount += 1
  }
  return summary
}

function computeMetrics(
  scores: MoonlightBlockScore[],
  selectedBlock: FinalContextBlockSummary,
  retainedQueryTerms: string[],
  systemScores: MoonlightBlockScore[]
): MoonlightReport['metrics'] {
  const matchedScores = scores.filter((score) => score.rawScore > 0)
  const weightedMatchedScores = scores.filter((score) => score.weightedScore > 0)
  const totalRaw = scores.reduce((sum, score) => sum + score.rawScore, 0)
  const aiRaw = scores.filter((score) => score.displayRole === 'assistant').reduce((sum, score) => sum + score.rawScore, 0)
  const externalRaw = scores.filter((score) => score.displayRole !== 'assistant').reduce((sum, score) => sum + score.rawScore, 0)
  const systemRaw = systemScores.reduce((sum, score) => sum + score.rawScore, 0)
  const recentUserRaw = scores
    .filter((score) => score.displayRole === 'user' && selectedBlock.index - score.blockIndex <= 3)
    .reduce((sum, score) => sum + score.rawScore, 0)

  const coverage = scores.length > 0 ? matchedScores.length / scores.length : 0
  const weightedCoverage = scores.length > 0 ? weightedMatchedScores.length / scores.length : 0
  const gapMax = computeGapMax(scores)
  const edgeBias = computeEdgeBias(scores)
  const midVoid = computeMidVoid(scores)
  const selfEchoRatio = totalRaw > 0 ? aiRaw / totalRaw : 0
  const externalSupportRatio = totalRaw > 0 ? externalRaw / totalRaw : 0
  const systemSupportRatio = totalRaw > 0 ? systemRaw / totalRaw : 0
  const recentUserSupportRatio = totalRaw > 0 ? recentUserRaw / totalRaw : 0
  const globality = estimateGlobality(selectedBlock.text)
  const contextAttentionProxy = clamp01((weightedCoverage * 0.35) + ((1 - midVoid) * 0.25) + ((1 - edgeBias) * 0.15) + (externalSupportRatio * 0.25))
  const systemAdherenceProxy = clamp01((systemSupportRatio * 0.65) + (Math.min(1, systemScores.filter((score) => score.rawScore > 0).length / 3) * 0.25) + (retainedQueryTerms.length > 0 ? 0.1 : 0))
  const selfEchoRisk = clamp01((selfEchoRatio * 0.8) + ((1 - externalSupportRatio) * 0.2))
  const hollowSummaryRisk = clamp01((globality * 0.45) + (edgeBias * 0.25) + (midVoid * 0.2) + ((1 - coverage) * 0.1))

  return {
    coverage,
    weightedCoverage,
    gapMax,
    edgeBias,
    midVoid,
    selfEchoRatio,
    externalSupportRatio,
    systemSupportRatio,
    recentUserSupportRatio,
    contextAttentionProxy,
    systemAdherenceProxy,
    selfEchoRisk,
    hollowSummaryRisk,
  }
}

function computeGapMax(scores: MoonlightBlockScore[]): number {
  let current = 0
  let max = 0
  for (const score of scores) {
    if (score.rawScore > 0) {
      current = 0
    } else {
      current += 1
      max = Math.max(max, current)
    }
  }
  return max
}

function computeEdgeBias(scores: MoonlightBlockScore[]): number {
  if (scores.length === 0) return 0
  const total = scores.reduce((sum, score) => sum + score.rawScore, 0)
  if (total <= 0) return 0
  const edgeSize = Math.max(1, Math.ceil(scores.length * 0.2))
  const edgeScore = [
    ...scores.slice(0, edgeSize),
    ...scores.slice(Math.max(edgeSize, scores.length - edgeSize)),
  ].reduce((sum, score) => sum + score.rawScore, 0)
  return clamp01(edgeScore / total)
}

function computeMidVoid(scores: MoonlightBlockScore[]): number {
  if (scores.length < 3) return 0
  const start = Math.floor(scores.length * 0.25)
  const end = Math.ceil(scores.length * 0.75)
  const mid = scores.slice(start, end)
  if (mid.length === 0) return 0
  const missed = mid.filter((score) => score.rawScore <= 0).length
  return missed / mid.length
}

function estimateGlobality(text: string): number {
  const value = String(text || '')
  const markers = ['综上', '整体', '总体', '本质', '全局', '整个', '说明', '可以看出', '因此', '结论', '总之']
  const hits = markers.filter((marker) => value.includes(marker)).length
  return clamp01(hits / 3)
}

function buildLabels(metrics: MoonlightReport['metrics'], selectedBlock: FinalContextBlockSummary, scores: MoonlightBlockScore[]): string[] {
  const labels: string[] = []
  if (metrics.selfEchoRisk >= 0.55) labels.push('自激回声风险：历史 AI 命中占比较高，外部证据相对较弱')
  if (metrics.hollowSummaryRisk >= 0.55) labels.push('空洞总结风险：全局表述与命中覆盖可能不匹配')
  if (metrics.systemAdherenceProxy >= 0.45) labels.push('系统提示词材料关联：检测到一定 system 命中')
  if (metrics.recentUserSupportRatio >= 0.35) labels.push('最近用户牵引：主要命中近邻 USER 块')
  if (scores.length > 0 && scores.every((score) => score.rawScore <= 0)) labels.push('低词项支撑：此前上下文几乎没有命中该 AI 输出材料')
  if (!labels.length) labels.push(`池月1号：已对 #${selectedBlock.index} 完成上下文词项分布统计`)
  return labels
}

function createPreview(text: string, maxLength = 140): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}