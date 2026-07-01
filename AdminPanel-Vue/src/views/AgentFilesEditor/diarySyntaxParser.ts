export type DiarySyntaxShell = "advancedDynamic" | "advancedFixed" | "directDynamic" | "directStatic";
export type DiaryDslPage = "advanced" | "direct";
export type DiarySyntaxMode = "dynamic" | "fixed";
export type DiaryDirectSyntaxMode = "static" | "dynamic";
export type DiaryDirectRecallMode = "none" | "random" | "randomN" | "lastN" | "bm25" | "bm25Plus";
export type DiaryAiMode = "none" | "aimemo" | "aimemoPlus";
export type DiarySuffixKey =
  | "time"
  | "group"
  | "bm25Plus"
  | "bm25"
  | "rerank"
  | "timeDecay"
  | "expand"
  | "associate"
  | "base64Memo"
  | "tagMemo"
  | "tagMemoPlus"
  | "rerankPlus"
  | "truncate"
  | "roleValve";

export interface DiarySyntaxRange {
  start: number;
  end: number;
}

export interface DiarySyntaxEditorState {
  notebookName: string;
  dslPage: DiaryDslPage;
  syntaxMode: DiarySyntaxMode;
  directSyntaxMode: DiaryDirectSyntaxMode;
  directRecallMode: DiaryDirectRecallMode;
  directRandomCount: string;
  directLastCount: string;
  directRoleValveEnabled: boolean;
  useKMultiplier: boolean;
  kMultiplier: string;
  timeRatio: string;
  bm25Weight: string;
  bm25PlusWeight: string;
  tagMemoWeight: string;
  tagMemoPlusWeight: string;
  rerankPlusAlpha: string;
  timeDecayHalfLifeDays: string;
  timeDecayMinScore: string;
  timeDecayTargetTags: string;
  truncateThreshold: string;
  aiMode: DiaryAiMode;
  aiPreset: string;
  roleValveJoiner: "&" | "|";
  roleValveConditions: string[];
  enabledSuffixes: Record<DiarySuffixKey, boolean>;
}

export interface DiarySyntaxMatch {
  id: string;
  raw: string;
  inner: string;
  notebookName: string;
  shell: DiarySyntaxShell;
  start: number;
  end: number;
  line: number;
  column: number;
  suffixes: string[];
  kMultiplier: string;
  state: DiarySyntaxEditorState;
}

export function createDefaultDiarySyntaxState(): DiarySyntaxEditorState {
  return {
    notebookName: "小吉日记本",
    dslPage: "advanced",
    syntaxMode: "dynamic",
    directSyntaxMode: "static",
    directRecallMode: "none",
    directRandomCount: "5",
    directLastCount: "10",
    directRoleValveEnabled: false,
    useKMultiplier: false,
    kMultiplier: "1.5",
    timeRatio: "",
    bm25Weight: "",
    bm25PlusWeight: "",
    tagMemoWeight: "",
    tagMemoPlusWeight: "",
    rerankPlusAlpha: "",
    timeDecayHalfLifeDays: "",
    timeDecayMinScore: "",
    timeDecayTargetTags: "",
    truncateThreshold: "0.4",
    aiMode: "none",
    aiPreset: "",
    roleValveJoiner: "&",
    roleValveConditions: [],
    enabledSuffixes: {
      time: false,
      group: false,
      bm25Plus: false,
      bm25: false,
      rerank: false,
      timeDecay: false,
      expand: false,
      associate: false,
      base64Memo: false,
      tagMemo: false,
      tagMemoPlus: false,
      rerankPlus: false,
      truncate: false,
      roleValve: false,
    },
  };
}

export function scanDiarySyntaxes(content: string): DiarySyntaxMatch[] {
  const matches: DiarySyntaxMatch[] = [];
  const syntaxPattern = /\{\{([^{}\r\n]+)\}\}|<<([^<>\r\n]+)>>|\[\[([^\[\]\r\n]+)\]\]|《《([^《》\r\n]+)》》/g;
  let match: RegExpExecArray | null;

  while ((match = syntaxPattern.exec(content)) !== null) {
    const raw = match[0];
    const inner = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();

    if (!inner) {
      continue;
    }

    const shell = getShellFromMatch(match);
    const parsed = parseDiarySyntaxInner(inner, shell);
    if (!parsed) {
      continue;
    }

    const position = getLineColumn(content, match.index);
    matches.push({
      id: `${match.index}-${raw}`,
      raw,
      inner,
      shell,
      start: match.index,
      end: match.index + raw.length,
      line: position.line,
      column: position.column,
      ...parsed,
    });
  }

  return matches;
}

function getShellFromMatch(match: RegExpExecArray): DiarySyntaxShell {
  if (typeof match[1] === "string") return "directStatic";
  if (typeof match[2] === "string") return "directDynamic";
  if (typeof match[3] === "string") return "advancedFixed";
  return "advancedDynamic";
}

function parseDiarySyntaxInner(
  inner: string,
  shell: DiarySyntaxShell
): Pick<DiarySyntaxMatch, "notebookName" | "suffixes" | "kMultiplier" | "state"> | null {
  const state = createDefaultDiarySyntaxState();
  state.dslPage = shell === "directStatic" || shell === "directDynamic" ? "direct" : "advanced";
  state.syntaxMode = shell === "advancedFixed" ? "fixed" : "dynamic";
  state.directSyntaxMode = shell === "directDynamic" ? "dynamic" : "static";

  const { body, kMultiplier } = extractKMultiplier(inner, state.dslPage);
  const parts = body
    .split("::")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const notebookName = parts.shift()?.trim() ?? "";
  if (!notebookName) {
    return null;
  }

  state.notebookName = notebookName;
  state.useKMultiplier = Boolean(kMultiplier);
  if (kMultiplier) {
    state.kMultiplier = kMultiplier;
  }

  const suffixes = parts;
  if (!isLikelyDiaryOrKnowledgeSyntax(shell, notebookName)) {
    return null;
  }

  suffixes.forEach((suffix) => {
    if (state.dslPage === "direct") {
      applyDirectSuffix(state, suffix);
      return;
    }

    applyAdvancedSuffix(state, suffix);
  });

  return {
    notebookName,
    suffixes,
    kMultiplier,
    state,
  };
}

function extractKMultiplier(inner: string, dslPage: DiaryDslPage): { body: string; kMultiplier: string } {
  if (dslPage !== "advanced") {
    return { body: inner, kMultiplier: "" };
  }

  const match = inner.match(/:([0-9]+(?:\.[0-9]+)?)\s*$/);
  if (!match || typeof match.index !== "number") {
    return { body: inner, kMultiplier: "" };
  }

  return {
    body: inner.slice(0, match.index),
    kMultiplier: match[1],
  };
}

function isLikelyDiaryOrKnowledgeSyntax(shell: DiarySyntaxShell, notebookName: string): boolean {
  const normalizedNames = notebookName
    .split("|")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const hasDiaryNotebook = normalizedNames.some((name) => name.includes("日记本"));
  const hasKnowledgeBase = normalizedNames.some((name) => name.includes("知识库"));
  const isDirect = shell === "directStatic" || shell === "directDynamic";
 
  if (isDirect) {
    return hasDiaryNotebook;
  }

  return hasDiaryNotebook || hasKnowledgeBase;
}

function applyDirectSuffix(state: DiarySyntaxEditorState, suffix: string): void {
  const roleValve = suffix.match(/^RoleValve(.+)$/i);
  if (roleValve) {
    state.directRoleValveEnabled = true;
    applyRoleValveExpression(state, roleValve[1]);
    return;
  }

  const random = suffix.match(/^Random(\d*)$/i);
  if (random) {
    const count = random[1];
    if (count) {
      state.directRecallMode = "randomN";
      state.directRandomCount = count;
    } else {
      state.directRecallMode = "random";
    }
    return;
  }

  const last = suffix.match(/^Last(\d*)$/i);
  if (last) {
    state.directRecallMode = "lastN";
    state.directLastCount = last[1] || "10";
    return;
  }

  if (/^BM25\+$/i.test(suffix)) {
    state.directRecallMode = "bm25Plus";
    return;
  }

  if (/^BM25$/i.test(suffix)) {
    state.directRecallMode = "bm25";
  }
}

function applyAdvancedSuffix(state: DiarySyntaxEditorState, suffix: string): void {
  const roleValve = suffix.match(/^RoleValve(.+)$/i);
  if (roleValve) {
    state.enabledSuffixes.roleValve = true;
    applyRoleValveExpression(state, roleValve[1]);
    return;
  }

  const timeDecay = suffix.match(/^TimeDecay(?:(\d+(?:\.\d+)?)(?:\/([0-9.]+))?(?:\/(.+))?)?$/i);
  if (timeDecay) {
    state.enabledSuffixes.timeDecay = true;
    state.timeDecayHalfLifeDays = timeDecay[1] ?? "";
    state.timeDecayMinScore = timeDecay[2] ?? "";
    state.timeDecayTargetTags = timeDecay[3] ?? "";
    return;
  }

  const truncate = suffix.match(/^Truncate([0-9.]+)?$/i);
  if (truncate) {
    state.enabledSuffixes.truncate = true;
    state.truncateThreshold = truncate[1] ?? "0.4";
    return;
  }

  const tagMemoPlus = suffix.match(/^TagMemo\+([0-9.]+)?$/i);
  if (tagMemoPlus) {
    state.enabledSuffixes.tagMemoPlus = true;
    state.enabledSuffixes.tagMemo = false;
    state.tagMemoPlusWeight = tagMemoPlus[1] ?? "";
    return;
  }

  const tagMemo = suffix.match(/^TagMemo([0-9.]+)?$/i);
  if (tagMemo) {
    state.enabledSuffixes.tagMemo = true;
    state.enabledSuffixes.tagMemoPlus = false;
    state.tagMemoWeight = tagMemo[1] ?? "";
    return;
  }

  const rerankPlus = suffix.match(/^Rerank\+([0-9.]+)?$/i);
  if (rerankPlus) {
    state.enabledSuffixes.rerankPlus = true;
    state.enabledSuffixes.rerank = false;
    state.rerankPlusAlpha = rerankPlus[1] ?? "";
    return;
  }

  if (/^Rerank$/i.test(suffix)) {
    state.enabledSuffixes.rerank = true;
    state.enabledSuffixes.rerankPlus = false;
    return;
  }

  const bm25Plus = suffix.match(/^BM25\+([0-9.]+)?$/i);
  if (bm25Plus) {
    state.enabledSuffixes.bm25Plus = true;
    state.bm25PlusWeight = bm25Plus[1] ?? "";
    return;
  }

  const bm25 = suffix.match(/^BM25([0-9.]+)?$/i);
  if (bm25) {
    state.enabledSuffixes.bm25 = true;
    state.bm25Weight = bm25[1] ?? "";
    return;
  }

  const time = suffix.match(/^Time([0-9.]+)?$/i);
  if (time) {
    state.enabledSuffixes.time = true;
    state.timeRatio = time[1] ?? "";
    return;
  }

  const aimemoPlus = suffix.match(/^AIMemo\+(?::(.+))?$/i);
  if (aimemoPlus) {
    state.aiMode = "aimemoPlus";
    state.aiPreset = aimemoPlus[1] ?? "";
    return;
  }

  const aimemo = suffix.match(/^AIMemo(?::(.+))?$/i);
  if (aimemo) {
    state.aiMode = "aimemo";
    state.aiPreset = aimemo[1] ?? "";
    return;
  }

  if (/^Group$/i.test(suffix)) state.enabledSuffixes.group = true;
  if (/^Expand$/i.test(suffix)) state.enabledSuffixes.expand = true;
  if (/^Associate$/i.test(suffix)) state.enabledSuffixes.associate = true;
  if (/^Base64Memo$/i.test(suffix)) state.enabledSuffixes.base64Memo = true;
}

function applyRoleValveExpression(state: DiarySyntaxEditorState, expression: string): void {
  const normalized = expression.trim();
  if (!normalized) {
    return;
  }

  state.roleValveJoiner = normalized.includes("|") && !normalized.includes("&") ? "|" : "&";
  state.roleValveConditions = normalized
    .split(/[&|]/)
    .map((condition) => condition.trim())
    .filter((condition) => condition.length > 0);
}

function getLineColumn(content: string, index: number): { line: number; column: number } {
  const before = content.slice(0, index);
  const lines = before.split(/\r\n|\n|\r/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}