'use strict';

/**
 * modules/vcpProtocolResilience/classifier.js
 * 负责类别 III 闭合坏块错误归类纯函数（优先级 1 → 2 → 3 严格调度、口吃去重放行）
 */
const { checkBlacklistConflict } = require('./blacklist');
const { sanitizeGuidanceInterpolation } = require('./guidanceAssembler');
const { calculateFingerprint, resolveFuzzyMatching } = require('./spans');

const STRICT_LOWERCASE_KEYS = new Set([
  'tool_name', 'maid', 'valet', 'archery', 'ink', 'river', 'vref', 'timely_contact', 'tool_password'
]);

const FUZZY_START_MARKERS = ['「始」', '{始}', '{始」', '「始}'];
const FUZZY_END_MARKERS = ['「末」', '{末}', '{末」', '「末}'];
const INNER_ESC_OPEN_RE = /(?:「始|\{始)(?:ESCAPE|escape)(?:」|\})/gi;
const INNER_ESC_CLOSE_RE = /(?:「末|\{末)(?:ESCAPE|escape)(?:」|\})/gi;
const NEXT_FIELD_STRICT_RE = /(?:^|\n)[ \t]*[a-zA-Z0-9_]+[ \t]*:[ \t\r\n]*(?:「始(?:ESCAPE|escape)?[」}]|\{始(?:ESCAPE|escape)?[」}])/;
const NEXT_FIELD_FUZZY_RE = /(?:^|\n)[ \t]*[a-zA-Z0-9_]+[ \t]*:[ \t\r\n]*(?:「始(?:ESCAPE|escape|_[a-zA-Z0-9_-]+)?[」}]|\{始(?:ESCAPE|escape|_[a-zA-Z0-9_-]+)?[」}])/;
const NEXT_BLOCK_STRICT_RE = /(?:^|\n)[ \t]*<<<\[END_TOOL_REQUEST\]>>>/;
const NEXT_BLOCK_FUZZY_RE = /(?:^|\n)[ \t]*<{2,4}\[END_TOOL_REQUEST\]>{2,4}/i;

/**
 * 解析并切分工具块内部字段结构
 * @param {string} inner 剥离了外框的内部文本
 * @param {object} [options={}] 配置
 * @returns {object} 解析出的字段映射与语法特征
 */
function inspectInnerFields(inner, options = {}) {
  const result = {
    isEmpty: false,
    hasValidFields: false,
    hasEqualSyntax: false,
    hasFullWidthColon: false,
    hasQuotesWithoutDelimiters: false,
    hasBareValueSyntax: false,
    hasFuzzyDelimiters: false,
    hasUnclosedField: false,
    hasEscapeError: false,
    invalidKeyError: null,
    casingKeyError: null,
    fieldList: [],
    toolNames: [],
    jevs: [],
    maids: [],
    valets: [],
    maid: null,
    valet: null
  };

  const trimmed = inner.trim();
  if (!trimmed) {
    result.isEmpty = true;
    return result;
  }

  // 状态机细扫字段定界符、转义套娃与键名（完全屏蔽字段内部的等号、引号与业务语法）
  let cursor = 0;
  const len = inner.length;
  const isFuzzy = resolveFuzzyMatching(options);
  const lastSepPos = Math.max(inner.lastIndexOf(':'), inner.lastIndexOf('='), inner.lastIndexOf('：'));
  const wsRe = /[ \t\r\n,，\uFEFF\u200B]+/y;
  const prefixRe = /([\u4e00-\u9fa5]+[：:][ \t]*)[a-zA-Z0-9_]+[ \t]*:/y;
  const keyRe = /([^:=： \t\r\n]+)[ \t]*([:=：])[ \t]*/y;
  const junkTokenRe = /[^ \t\r\n,，\uFEFF\u200B:=：「」{}]+/y;
  const nlDelimRe = /(?:\r?\n[ \t]*)+(?=(?:「始|\{始))/y;
  const stdEscOpenRe = /「始(?:ESCAPE|escape)」/iy;
  const fuzzyEscOpenRe = /[「{]始(?:ESCAPE|escape)[」}]/iy;
  const wildStartRe = /[「{]始(?!ESCAPE)(?:[^\r\n「{]*?[」}])/iy;
  const fuzzyEndScanRe = /[「{]末(?!ESCAPE)[^\r\n「{]*?[」}]/gi;
  const strictFuzzyEndRe = /「末」|\{末\}|\{末」|「末\}/g;
  const hasInnerEscInInner = /ESCAPE/i.test(inner);
  let cachedInnerEscOpenM = hasInnerEscInInner ? undefined : null;

  while (cursor < len) {
    // 跳过空白、逗号与注释
    wsRe.lastIndex = cursor;
    const wsMatch = wsRe.exec(inner);
    if (wsMatch) {
      cursor += wsMatch[0].length;
      continue;
    }

    let keyMatch = null;
    if (cursor <= lastSepPos) {
      // 检查短中文前缀与合法键
      // 例：命运检定数：tool_name:「始」... -> 跳过短中文前缀
      prefixRe.lastIndex = cursor;
      const prefixMatch = prefixRe.exec(inner);
      if (prefixMatch) {
        cursor += prefixMatch[1].length;
      }

      // 尝试匹配键名与分隔符（半角冒号 :，全角冒号 ：，等号 =）
      keyRe.lastIndex = cursor;
      keyMatch = keyRe.exec(inner);
    }
    if (!keyMatch) {
      // 无法识别为合法键名的杂质字符或游离定界符
      if (inner.startsWith("「始", cursor) || inner.startsWith("「末", cursor) ||
          inner.startsWith("{始", cursor) || inner.startsWith("{末", cursor)) {
        result.hasUnclosedField = true;
        cursor += 2;
        continue;
      }
      junkTokenRe.lastIndex = cursor;
      const junkMatch = junkTokenRe.exec(inner);
      cursor += junkMatch ? junkMatch[0].length : 1;
      continue;
    }

    const rawKey = keyMatch[1];
    const sep = keyMatch[2];
    cursor += keyMatch[0].length;

    // 冒号后紧跟换行+可选缩进+定界符起头时，对齐原生 ToolCallParser._scanFields 跳过换行缩进
    if (sep === ':') {
      nlDelimRe.lastIndex = cursor;
      const nlDelimMatch = nlDelimRe.exec(inner);
      if (nlDelimMatch) {
        cursor += nlDelimMatch[0].length;
      }
    }

    if (sep === "=") {
      result.hasEqualSyntax = true;
    } else if (sep === "：") {
      result.hasFullWidthColon = true;
    }

    // 键名大小写校验（8 个严格小写控制键）
    const lowerKey = rawKey.toLowerCase();
    if (STRICT_LOWERCASE_KEYS.has(lowerKey) && rawKey !== lowerKey) {
      if (!result.casingKeyError) {
        result.casingKeyError = rawKey;
      }
    }

    // 键名非法字符校验（中划线、点号、中文错键名）
    if (!/^[a-zA-Z0-9_]+$/.test(rawKey)) {
      if (!result.invalidKeyError) {
        result.invalidKeyError = sanitizeGuidanceInterpolation(rawKey, 48) || '非法协议字符';
      }
    }

    // 解析字段值
    // 形态 A：以「始ESCAPE」或模糊转义体开头的转义字段
    stdEscOpenRe.lastIndex = cursor;
    const stdEscM = stdEscOpenRe.exec(inner);
    let fuzzyEscM = null;
    if (isFuzzy) {
      fuzzyEscOpenRe.lastIndex = cursor;
      fuzzyEscM = fuzzyEscOpenRe.exec(inner);
    }

    if (stdEscM || fuzzyEscM) {
      const escOpenLen = fuzzyEscM ? fuzzyEscM[0].length : stdEscM[0].length;
      cursor += escOpenLen;
      let escCloseIdx = -1;
      let escCloseLen = "「末ESCAPE」".length;
      const re = isFuzzy
        ? /[「{]末(?:ESCAPE|escape)[」}]/gi
        : /「末(?:ESCAPE|escape)」/gi;
      re.lastIndex = cursor;
      const match = re.exec(inner);
      if (match) {
        escCloseIdx = match.index;
        escCloseLen = match[0].length;
      }
      if (escCloseIdx === -1) {
        result.hasUnclosedField = true;
        break;
      }
      const valSlice = inner.slice(cursor, escCloseIdx);
      // 检查转义体内部是否嵌套了 ≥ 2 层的「始ESCAPE」或模糊交叉转义体
      if (isFuzzy ? /[「{]始(?:ESCAPE|escape)[」}]/i.test(valSlice) : /「始(?:ESCAPE|escape)」/i.test(valSlice)) {
        result.hasEscapeError = true;
      }
      cursor = escCloseIdx + escCloseLen;
      recordField(result, rawKey, valSlice, true);
      continue;
    }

    // 形态 B：以「始」开头的标准定界符字段（在 fuzzyToolMatching 开启时允许交叉闭合，兼容内嵌单层 ESCAPE）
    if (inner.startsWith("「始」", cursor)) {
      cursor += "「始」".length;
      let scanPos = cursor;
      let normCloseIdx = -1;
      let normCloseLen = "「末」".length;
      const gapParts = [];
      let gapStart = cursor;

      while (scanPos < len) {
        let candCloseIdx = -1;
        let candCloseLen = "「末」".length;
        if (isFuzzy) {
          fuzzyEndScanRe.lastIndex = scanPos;
          const m = fuzzyEndScanRe.exec(inner);
          if (m) {
            candCloseIdx = m.index;
            candCloseLen = m[0].length;
          }
        } else {
          candCloseIdx = inner.indexOf("「末」", scanPos);
        }
        if (candCloseIdx === -1) break;

        if (cachedInnerEscOpenM === undefined || (cachedInnerEscOpenM !== null && cachedInnerEscOpenM.index < scanPos)) {
          INNER_ESC_OPEN_RE.lastIndex = scanPos;
          cachedInnerEscOpenM = INNER_ESC_OPEN_RE.exec(inner);
        }
        const escOpenM = cachedInnerEscOpenM;
        if (escOpenM && escOpenM.index < candCloseIdx) {
          INNER_ESC_CLOSE_RE.lastIndex = escOpenM.index + escOpenM[0].length;
          const escCloseM = INNER_ESC_CLOSE_RE.exec(inner);
          if (escCloseM) {
            gapParts.push(inner.slice(gapStart, escOpenM.index));
            scanPos = escCloseM.index + escCloseM[0].length;
            gapStart = scanPos;
            continue;
          }
        }

        normCloseIdx = candCloseIdx;
        normCloseLen = candCloseLen;
        break;
      }

      if (normCloseIdx === -1) {
        result.hasUnclosedField = true;
        break;
      }
      const valSlice = inner.slice(cursor, normCloseIdx);
      const checkSlice = gapParts.length > 0
        ? (gapParts.push(inner.slice(gapStart, normCloseIdx)), gapParts.join('_'))
        : valSlice;
      // 漏「末」硬防线仅在遇到真正的外部结构定界符时触发：
      // 1. 下一个独立行字段开标
      // 2. 外部块开标 <<<[TOOL_REQUEST]>>> 或块尾标
      const hasNextField = (isFuzzy ? NEXT_FIELD_FUZZY_RE : NEXT_FIELD_STRICT_RE).test(checkSlice);
      const hasNextBlock = (isFuzzy ? NEXT_BLOCK_FUZZY_RE : NEXT_BLOCK_STRICT_RE).test(checkSlice);
      if (hasNextField || hasNextBlock) {
        result.hasUnclosedField = true;
        break;
      }
      cursor = normCloseIdx + normCloseLen;
      recordField(result, rawKey, valSlice, false);
      continue;
    }

    // 形态 C：模糊定界符（{始}、{始」、「始} 及 toolMarkerFuzzyMatcher 通配模糊定界符）
    let matchedFuzzyStart = isFuzzy
      ? FUZZY_START_MARKERS.find(m => m !== '「始」' && inner.startsWith(m, cursor))
      : ['{始}', '{始」', '「始}'].find(m => inner.startsWith(m, cursor));
    if (!matchedFuzzyStart && isFuzzy) {
      wildStartRe.lastIndex = cursor;
      const wildStartM = wildStartRe.exec(inner);
      if (wildStartM) matchedFuzzyStart = wildStartM[0];
    }

    if (matchedFuzzyStart) {
      if (!isFuzzy) {
        result.hasFuzzyDelimiters = true;
      }
      cursor += matchedFuzzyStart.length;
      let fCloseIdx = -1;
      let fCloseLen = 0;
      if (isFuzzy) {
        fuzzyEndScanRe.lastIndex = cursor;
        const m = fuzzyEndScanRe.exec(inner);
        if (m) {
          fCloseIdx = m.index;
          fCloseLen = m[0].length;
        }
      } else {
        strictFuzzyEndRe.lastIndex = cursor;
        const m = strictFuzzyEndRe.exec(inner);
        if (m) {
          fCloseIdx = m.index;
          fCloseLen = m[0].length;
        }
      }
      if (fCloseIdx === -1) {
        result.hasUnclosedField = true;
        break;
      }
      const valSlice = inner.slice(cursor, fCloseIdx);
      // 漏「末」硬防线仅在遇到真正的外部结构定界符时触发：
      // 1. 下一个独立行字段开标
      // 2. 外部块开标 <<<[TOOL_REQUEST]>>> 或块尾标
      const hasNextField = (isFuzzy ? NEXT_FIELD_FUZZY_RE : NEXT_FIELD_STRICT_RE).test(valSlice);
      const hasNextBlock = (isFuzzy ? NEXT_BLOCK_FUZZY_RE : NEXT_BLOCK_STRICT_RE).test(valSlice);
      if (hasNextField || hasNextBlock) {
        result.hasUnclosedField = true;
        break;
      }
      cursor = fCloseIdx + fCloseLen;
      recordField(result, rawKey, valSlice, false);
      continue;
    }

    // 形态 D：直接紧随引号（如 key="val" 或 key: "val"）
    if (inner[cursor] === '"' || inner[cursor] === "'") {
      result.hasQuotesWithoutDelimiters = true;
      const q = inner[cursor];
      cursor++;
      const qClose = inner.indexOf(q, cursor);
      if (qClose === -1) {
        result.hasUnclosedField = true;
        break;
      }
      const valSlice = inner.slice(cursor, qClose);
      cursor = qClose + 1;
      recordField(result, rawKey, valSlice, false);
      continue;
    }

    // 形态 E：缺少定界符或语法残损（裸写参数）
    result.hasBareValueSyntax = true;
    const nextNl = inner.indexOf("\n", cursor);
    cursor = nextNl === -1 ? len : nextNl + 1;
  }

  if (result.fieldList.length > 0) {
    result.hasValidFields = true;
  }

  return result;
}

function recordField(result, rawKey, valSlice, isEscape) {
  const lowerKey = rawKey.toLowerCase();
  const item = { rawKey, value: valSlice.trim(), isEscape };
  result.fieldList.push(item);

  if (lowerKey === 'tool_name') {
    result.toolNames.push(item);
  } else if (lowerKey === 'jev') {
    result.jevs.push(item);
  } else if (lowerKey === 'maid') {
    if (!result.maid) result.maid = item;
    result.maids.push(item);
  } else if (lowerKey === 'valet') {
    if (!result.valet) result.valet = item;
    result.valets.push(item);
  }
}

/**
 * 闭合块错误归类纯函数（优先级 1 → 2 → 3 严格调度、口吃去重放行）
 *
 * @param {string} blockText 从 <<<[TOOL_REQUEST]>>> 到 <<<[END_TOOL_REQUEST]>>> 的完整闭合块文本
 * @param {object} [options={}] 配置项（包含 pluginManager, agentManager, fuzzyToolMatching 等）
 * @returns {object|null} 命中错误时返回结构化 ProtocolErrorCall 对象，100% 合法时返回 null
 */
function _classifyClosedBlockError(blockText, options = {}) {
  if (typeof blockText !== 'string') return null;

  const trimmed = blockText.trim();
  const START_MARKER = '<<<[TOOL_REQUEST]>>>';
  const END_MARKER = '<<<[END_TOOL_REQUEST]>>>';

  const isFuzzyOuter = resolveFuzzyMatching(options);
  let inner = trimmed;
  if (isFuzzyOuter) {
    inner = inner.replace(/^<{2,4}\[TOOL_REQUEST\]>{2,4}/i, '').replace(/<{2,4}\[END_TOOL_REQUEST\]>{2,4}$/i, '');
  } else {
    if (inner.startsWith(START_MARKER)) {
      inner = inner.slice(START_MARKER.length);
    }
    if (inner.endsWith(END_MARKER)) {
      inner = inner.slice(0, -END_MARKER.length);
    }
  }

  const inspected = inspectInnerFields(inner, options);

  // ==========================================
  // ① 优先级 1（全空或不可识别杂质块兜底）
  // ==========================================
  const hasSyntaxIssues = inspected.hasUnclosedField || inspected.hasEscapeError ||
                          inspected.hasEqualSyntax || inspected.hasFullWidthColon ||
                          inspected.hasQuotesWithoutDelimiters || inspected.hasBareValueSyntax || inspected.hasFuzzyDelimiters;

  if (inspected.isEmpty || (!inspected.hasValidFields && inspected.fieldList.length === 0 && !hasSyntaxIssues)) {
    return {
      isProtocolError: true,
      errorCode: 'EMPTY_OR_MALFORMED_FIELDS',
      errorDetail: '工具块内部为空或不包含任何有效字段！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'EMPTY_BLOCK',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  // ==========================================
  // ② 优先级 2（语法损坏 / 定界失控 / 控制键与黑名单错误 / 重复键冲突）
  // ==========================================

  // 2.1 重复键冲突检测与口吃放宽不变量（Stutter Invariant）
  if (inspected.toolNames.length >= 2) {
    const firstVal = inspected.toolNames[0].value;
    const isConflict = inspected.toolNames.some(t => t.value !== firstVal);
    if (isConflict) {
      return {
        isProtocolError: true,
        errorCode: 'MALFORMED_BLOCK_SYNTAX',
        errorDetail: '同一工具块内部重复定义了冲突的 tool_name，导致系统无法确定调用目标！',
        blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
        subType: 'DUPLICATE_KEY_CONFLICT',
        detectedPluginInMaid: null,
        pluginInMaid: null,
        roleNameInTool: null,
        isDuplicateConflict: true
      };
    }
    // 若取值完全相同（口吃），静默去重放行，不触发报错！
  }

  if (inspected.jevs.length >= 2) {
    const firstVal = inspected.jevs[0].value;
    const isConflict = inspected.jevs.some(t => t.value !== firstVal);
    if (isConflict) {
      return {
        isProtocolError: true,
        errorCode: 'MALFORMED_BLOCK_SYNTAX',
        errorDetail: inspected.toolNames.length > 0
          ? '同一工具块内部重复定义了冲突的 jev 参数，导致参数取值歧义！'
          : '同一工具块内部重复定义了冲突的 jev，导致系统无法确定调用目标！',
        blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
        subType: 'DUPLICATE_KEY_CONFLICT',
        detectedPluginInMaid: null,
        pluginInMaid: null,
        roleNameInTool: null,
        isDuplicateConflict: true
      };
    }
  }

  // 检查 maids / valets 重复冲突与混用
  if (inspected.maids.length > 0 && inspected.valets.length > 0) {
    return {
      isProtocolError: true,
      errorCode: 'MALFORMED_BLOCK_SYNTAX',
      errorDetail: '同一工具块内部严禁同时混用 maid 与 valet 署名字段！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'DUPLICATE_KEY_CONFLICT',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: true
    };
  }

  if (inspected.maids.length >= 2) {
    const firstVal = inspected.maids[0].value;
    const isConflict = inspected.maids.some(m => m.value !== firstVal);
    if (isConflict) {
      return {
        isProtocolError: true,
        errorCode: 'MALFORMED_BLOCK_SYNTAX',
        errorDetail: '同一工具块内部重复定义了冲突的 maid 署名，导致系统无法确定调用角色！',
        blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
        subType: 'DUPLICATE_KEY_CONFLICT',
        detectedPluginInMaid: null,
        pluginInMaid: null,
        roleNameInTool: null,
        isDuplicateConflict: true
      };
    }
  }

  if (inspected.valets.length >= 2) {
    const firstVal = inspected.valets[0].value;
    const isConflict = inspected.valets.some(v => v.value !== firstVal);
    if (isConflict) {
      return {
        isProtocolError: true,
        errorCode: 'MALFORMED_BLOCK_SYNTAX',
        errorDetail: '同一工具块内部重复定义了冲突的 valet 署名，导致系统无法确定调用角色！',
        blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
        subType: 'DUPLICATE_KEY_CONFLICT',
        detectedPluginInMaid: null,
        pluginInMaid: null,
        roleNameInTool: null,
        isDuplicateConflict: true
      };
    }
  }

  // 2.2 非法赋值语法与残损格式（等号、全角冒号、引号、模糊定界）
  if (inspected.hasEqualSyntax) {
    return {
      isProtocolError: true,
      errorCode: 'MALFORMED_BLOCK_SYNTAX',
      errorDetail: '参数赋值语法错误（禁止使用等号 = 赋值，参数必须使用 key:「始」val「末」格式）！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'EQUAL_ASSIGNMENT',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  if (inspected.hasFullWidthColon) {
    return {
      isProtocolError: true,
      errorCode: 'MALFORMED_BLOCK_SYNTAX',
      errorDetail: '参数赋值语法错误（禁止使用全角冒号 ：，必须使用半角冒号 : 搭配「始」「末」定界符）！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'FULL_WIDTH_COLON',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  if (inspected.hasQuotesWithoutDelimiters) {
    return {
      isProtocolError: true,
      errorCode: 'MALFORMED_BLOCK_SYNTAX',
      errorDetail: '参数赋值语法错误（禁止使用普通引号包裹参数，必须使用「始」与「末」完整包裹）！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'QUOTES_WITHOUT_DELIMITERS',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  if (inspected.hasBareValueSyntax) {
    return {
      isProtocolError: true,
      errorCode: 'MALFORMED_BLOCK_SYNTAX',
      errorDetail: '参数赋值语法错误（参数值缺少「始」与「末」定界符，禁止裸写参数）！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'MISSING_FIELD_DELIMITERS',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  if (inspected.hasFuzzyDelimiters) {
    return {
      isProtocolError: true,
      errorCode: 'MALFORMED_BLOCK_SYNTAX',
      errorDetail: '严格模式下禁止使用 {始} 与 {末} 模糊定界符，必须使用半角冒号与「始」「末」定界符！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'FUZZY_DELIMITER_DISALLOWED',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  // 2.3 字段定界符未成对或转义套娃失控
  if (inspected.hasEscapeError) {
    return {
      isProtocolError: true,
      errorCode: 'UNCLOSED_FIELD',
      errorDetail: '检测到嵌套 ≥2 层的转义保护符（「始ESCAPE」不可自嵌套）！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'NESTED_ESCAPE',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  if (inspected.hasUnclosedField) {
    return {
      isProtocolError: true,
      errorCode: 'UNCLOSED_FIELD',
      errorDetail: '参数定界符未成对闭合（检测到字段漏写配对的「末」或定界符错乱）！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'MISSING_CLOSING_DELIMITER',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  // 2.4 控制键大小写拼错
  if (inspected.casingKeyError) {
    const safeCasingKey = sanitizeGuidanceInterpolation(inspected.casingKeyError, 48) || '非法控制键';
    return {
      isProtocolError: true,
      errorCode: 'INVALID_TOOL_NAME',
      errorDetail: `工具控制键大小写错误（「${safeCasingKey}」必须严格全小写）！`,
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'KEY_CASING_MISMATCH',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  // 2.5 键名包含非法字符
  if (inspected.invalidKeyError) {
    const safeInvalidKey = sanitizeGuidanceInterpolation(inspected.invalidKeyError, 48) || '非法协议字符';
    return {
      isProtocolError: true,
      errorCode: 'INVALID_TOOL_NAME',
      errorDetail: `键名包含非法字符「${safeInvalidKey}」！`,
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'INVALID_KEY_CHARACTERS',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  // 2.6 黑名单反查（场景 B：已填 tool_name 但 maid 误填插件名；角色名误入 tool_name）
  const hasJev = inspected.jevs.length > 0;
  const activeToolName = inspected.toolNames[0]?.value || (hasJev ? 'JEV' : '');
  const signerItem = inspected.maid || inspected.valet;
  const signerKey = signerItem?.rawKey || 'maid';
  const signerVal = signerItem?.value || '';

  const blacklistConflict = checkBlacklistConflict(activeToolName, signerKey, signerVal, options);
  if (blacklistConflict) {
    // 若属于场景 B 或角色名入 tool_name，属于优先级 2 拦截
    if (blacklistConflict.subType === 'BLACKLIST_SCENARIO_B' || blacklistConflict.subType === 'ROLE_IN_TOOL_NAME') {
      return {
        ...blacklistConflict,
        blockFingerprint: calculateFingerprint(blockText, 0, blockText.length)
      };
    }
  }

  // ==========================================
  // ③ 优先级 3（缺失关键身份键）
  // ==========================================
  const hasToolName = Boolean(activeToolName);
  const hasSigner = Boolean(signerVal);

  // 缺键抢断：若同时缺 tool_name 与 maid/valet，优先报 MISSING_TOOL_NAME
  if (!hasJev && !hasToolName) {
    // 检查是否命中黑名单场景 A（已知插件名误填入 maid 且缺 tool_name）
    if (blacklistConflict && blacklistConflict.subType === 'BLACKLIST_SCENARIO_A') {
      return {
        ...blacklistConflict,
        blockFingerprint: calculateFingerprint(blockText, 0, blockText.length)
      };
    }
    return {
      isProtocolError: true,
      errorCode: 'MISSING_TOOL_NAME',
      errorDetail: '本轮工具调用缺少核心字段 tool_name，系统无法识别你要执行什么工具！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'MISSING_TOOL_NAME',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  // 有 tool_name（或有 JEV）但缺 maid/valet 署名
  if (!hasSigner) {
    return {
      isProtocolError: true,
      errorCode: 'MISSING_MAID',
      errorDetail: '本轮工具调用缺少 maid (女性) / valet (男性) 角色署名字段！',
      blockFingerprint: calculateFingerprint(blockText, 0, blockText.length),
      subType: 'MISSING_MAID',
      detectedPluginInMaid: null,
      pluginInMaid: null,
      roleNameInTool: null,
      isDuplicateConflict: false
    };
  }

  // 100% 格式合法，放行给原生解析执行
  return null;
}


function formatProtocolError(err) {
  if (!err) return null;
  return {
    name: 'VCP工具调用',
    args: {},
    archery: false,
    archeryNoReply: false,
    markHistory: false,
    isProtocolError: true,
    ...err
  };
}

function classifyClosedBlockError(blockText, options = {}) {
  const err = _classifyClosedBlockError(blockText, options);
  return formatProtocolError(err);
}

module.exports = {
  classifyClosedBlockError
};
