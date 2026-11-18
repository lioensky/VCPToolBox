"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const PLUGIN_DIR = path.resolve(__dirname, "..");
const SOURCE_PATH = path.join(PLUGIN_DIR, "OpenHerPersona.js");
const DEFAULT_DB_PATH = path.join(PLUGIN_DIR, "state", "openher-axis-state.sqlite");
const DEFAULT_REPORT_DIR = path.join(PLUGIN_DIR, "state", "calibration-reports");
const DEFAULT_AGENT = "Nova";
const EPSILON = 1e-12;

function parseArgs(argv) {
  const options = {
    agent: DEFAULT_AGENT,
    dbPath: DEFAULT_DB_PATH,
    reportDir: DEFAULT_REPORT_DIR,
    modelSig: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--agent" && argv[index + 1]) options.agent = argv[++index];
    else if (token === "--db" && argv[index + 1]) options.dbPath = path.resolve(argv[++index]);
    else if (token === "--out" && argv[index + 1]) options.reportDir = path.resolve(argv[++index]);
    else if (token === "--model" && argv[index + 1]) options.modelSig = argv[++index];
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`Unknown or incomplete argument: ${token}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node Plugin/OpenHerPersona/scripts/analyze-vector-baselines.js [options]

Options:
  --agent <name>   Agent key/label used to render {name}; default: Nova
  --db <path>      Existing SQLite database; opened read-only
  --out <dir>      Report output directory
  --model <sig>    Force a model signature instead of auto-selecting
  -h, --help       Show this help

Outputs:
  <agent>-vector-baseline-report.json
  <agent>-vector-baseline-report.md`);
}

function extractArrayLiteral(source, declarationName) {
  const declaration = `const ${declarationName} =`;
  const declarationIndex = source.indexOf(declaration);
  if (declarationIndex < 0) throw new Error(`Cannot find ${declarationName} in source`);

  const start = source.indexOf("[", declarationIndex + declaration.length);
  if (start < 0) throw new Error(`Cannot find array start for ${declarationName}`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`Cannot find array end for ${declarationName}`);
}

function loadAxisDefinitions() {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const literal = extractArrayLiteral(source, "AXIS_DEFINITIONS");
  const definitions = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error("AXIS_DEFINITIONS extraction returned no definitions");
  }
  return definitions;
}

function renderAnchorText(agent, template) {
  return String(template || "").replace(/\{name\}/g, agent);
}

function finiteVector(value) {
  return Array.isArray(value) && value.length > 0 && value.every(Number.isFinite);
}

function zeros(length) {
  return new Array(length).fill(0);
}

function add(left, right) {
  return left.map((value, index) => value + right[index]);
}

function subtract(left, right) {
  return left.map((value, index) => value - right[index]);
}

function scale(vector, factor) {
  return vector.map((value) => value * factor);
}

function dot(left, right) {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
  return result;
}

function norm(vector) {
  return Math.sqrt(Math.max(0, dot(vector, vector)));
}

function unit(vector) {
  const length = norm(vector);
  return length > EPSILON ? scale(vector, 1 / length) : zeros(vector.length);
}

function cosine(left, right) {
  const denominator = norm(left) * norm(right);
  return denominator > EPSILON ? dot(left, right) / denominator : 0;
}

function meanVector(vectors) {
  if (!vectors.length) return [];
  return scale(vectors.reduce((sum, vector) => add(sum, vector), zeros(vectors[0].length)), 1 / vectors.length);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function chooseModelSig(rows, requestedModelSig) {
  const counts = new Map();
  for (const row of rows) counts.set(row.model_sig, (counts.get(row.model_sig) || 0) + 1);
  if (requestedModelSig) return requestedModelSig;
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null;
}

function classifyGeometry(definition) {
  const anchors = definition.anchors || [];
  const masculine = anchors.filter((anchor) => anchor.pole === "masculine" || anchor.subAxis.startsWith("masculine_"));
  const feminine = anchors.filter((anchor) => anchor.pole === "feminine" || anchor.subAxis.startsWith("feminine_"));

  if (masculine.length === 1 && feminine.length === 1 && anchors.length === 2) return "bipolar";
  if (definition.axis === "psy_gender") return "multi_directional";
  if (definition.axis === "arousal" && anchors.some((anchor) => anchor.subAxis === "calm")) return "mixed_polarity";
  return "multi_prototype_intensity";
}

function buildExpectedAnchors(definitions, agent) {
  return definitions.flatMap((definition) =>
    definition.anchors.map((anchor) => ({
      layer: definition.layer,
      axis: definition.axis,
      subAxis: anchor.subAxis,
      pole: anchor.pole || null,
      text: renderAnchorText(agent, anchor.text),
      geometryType: classifyGeometry(definition),
    }))
  );
}

function queryDatabase(dbPath, agent) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    if (!tables.includes("openher_axis_anchors")) {
      throw new Error("Database does not contain openher_axis_anchors");
    }
    return db
      .prepare(
        `SELECT agent_key, layer, axis, sub_axis, anchor_text, vector_json, model_sig, updated_at
         FROM openher_axis_anchors
         WHERE agent_key = ?
         ORDER BY layer, axis, sub_axis, anchor_text`
      )
      .all(agent);
  } finally {
    db.close();
  }
}

function parseRows(rows) {
  return rows.map((row) => {
    let vector = null;
    let parseError = null;
    try {
      vector = JSON.parse(row.vector_json);
    } catch (error) {
      parseError = error.message;
    }
    return {
      ...row,
      vector,
      parseError,
      vectorValid: finiteVector(vector),
      vectorDimension: Array.isArray(vector) ? vector.length : null,
    };
  });
}

function matchCurrentAnchors(expected, parsedRows, modelSig) {
  const selectedRows = parsedRows.filter((row) => row.model_sig === modelSig);
  const exactIndex = new Map();
  for (const row of selectedRows) {
    const key = `${row.layer}\0${row.axis}\0${row.sub_axis}\0${row.anchor_text}`;
    if (!exactIndex.has(key)) exactIndex.set(key, []);
    exactIndex.get(key).push(row);
  }

  const current = [];
  const missing = [];
  const duplicateCurrent = [];
  const usedRows = new Set();

  for (const anchor of expected) {
    const key = `${anchor.layer}\0${anchor.axis}\0${anchor.subAxis}\0${anchor.text}`;
    const matches = exactIndex.get(key) || [];
    if (!matches.length) {
      missing.push(anchor);
      continue;
    }
    if (matches.length > 1) duplicateCurrent.push({ anchor, count: matches.length });
    const row = [...matches].sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0];
    usedRows.add(row);
    current.push({ ...anchor, row, vector: row.vector });
  }

  const historical = selectedRows
    .filter((row) => !usedRows.has(row))
    .map((row) => ({
      layer: row.layer,
      axis: row.axis,
      subAxis: row.sub_axis,
      text: row.anchor_text,
      updatedAt: row.updated_at,
      vectorValid: row.vectorValid,
      vectorDimension: row.vectorDimension,
    }));

  return { current, missing, duplicateCurrent, historical, selectedRows };
}

function pairwiseStats(items) {
  const pairs = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      pairs.push({
        left: items[left].subAxis,
        right: items[right].subAxis,
        cosine: cosine(items[left].vector, items[right].vector),
      });
    }
  }

  const values = pairs.map((pair) => pair.cosine);
  return {
    count: pairs.length,
    mean: round(mean(values)),
    min: round(values.length ? Math.min(...values) : 0),
    max: round(values.length ? Math.max(...values) : 0),
    pairs: pairs.map((pair) => ({ ...pair, cosine: round(pair.cosine) })),
  };
}

function analyzeBipolarAxis(items, origin) {
  const masculine = items.find((item) => item.pole === "masculine" || item.subAxis.startsWith("masculine_"));
  const feminine = items.find((item) => item.pole === "feminine" || item.subAxis.startsWith("feminine_"));
  if (!masculine || !feminine) return { valid: false, reason: "missing_pole" };

  const direction = unit(subtract(masculine.vector, feminine.vector));
  const masculineRadius = dot(subtract(masculine.vector, origin), direction);
  const feminineRadius = -dot(subtract(feminine.vector, origin), direction);
  const midpoint = scale(add(masculine.vector, feminine.vector), 0.5);
  const midpointBias = dot(subtract(midpoint, origin), direction);
  const sharedRadius = (masculineRadius + feminineRadius) / 2;

  return {
    valid: masculineRadius > EPSILON && feminineRadius > EPSILON,
    masculineSubAxis: masculine.subAxis,
    feminineSubAxis: feminine.subAxis,
    direction,
    masculineRadius: round(masculineRadius),
    feminineRadius: round(feminineRadius),
    sharedRadius: round(sharedRadius),
    midpointBias: round(midpointBias),
    biasToward: midpointBias > 0 ? "masculine" : midpointBias < 0 ? "feminine" : "balanced",
    masculineCorrection: round(sharedRadius / masculineRadius),
    feminineCorrection: round(sharedRadius / feminineRadius),
    pairCosine: round(cosine(masculine.vector, feminine.vector)),
    pairSeparation: round(norm(subtract(masculine.vector, feminine.vector))),
  };
}

function analyzePrototypeAxis(items, origin) {
  const centered = items.map((item) => subtract(item.vector, origin));
  const centroid = meanVector(centered);
  const direction = unit(centroid);
  const measured = items.map((item, index) => {
    const radius = dot(centered[index], direction);
    const residual = subtract(centered[index], scale(direction, radius));
    return {
      subAxis: item.subAxis,
      text: item.text,
      radius,
      transverseOffset: norm(residual),
      cosineToDirection: cosine(centered[index], direction),
    };
  });
  const positiveRadii = measured.map((item) => item.radius).filter((value) => value > EPSILON);
  const targetRadius = median(positiveRadii);
  const radialStd = standardDeviation(measured.map((item) => item.radius));
  const transverseValues = measured.map((item) => item.transverseOffset);
  const transverseMean = mean(transverseValues);
  const transverseStd = standardDeviation(transverseValues);

  return {
    valid: norm(centroid) > EPSILON,
    centroidNorm: round(norm(centroid)),
    direction,
    targetRadius: round(targetRadius),
    radialMean: round(mean(measured.map((item) => item.radius))),
    radialStd: round(radialStd),
    transverseMean: round(transverseMean),
    transverseStd: round(transverseStd),
    prototypes: measured.map((item) => ({
      subAxis: item.subAxis,
      text: item.text,
      radius: round(item.radius),
      correction: item.radius > EPSILON ? round(targetRadius / item.radius) : null,
      transverseOffset: round(item.transverseOffset),
      cosineToDirection: round(item.cosineToDirection),
      outlier:
        item.radius <= 0 ||
        Math.abs(item.radius - mean(measured.map((entry) => entry.radius))) > Math.max(0.02, radialStd * 1.5) ||
        item.transverseOffset > transverseMean + Math.max(0.02, transverseStd * 1.5),
    })),
  };
}

function analyzeAxes(definitions, current, origin) {
  const byAxis = new Map();
  for (const item of current) {
    if (!byAxis.has(item.axis)) byAxis.set(item.axis, []);
    byAxis.get(item.axis).push(item);
  }

  const analyses = [];
  for (const definition of definitions) {
    const items = byAxis.get(definition.axis) || [];
    const geometryType = classifyGeometry(definition);
    const base = {
      layer: definition.layer,
      axis: definition.axis,
      label: definition.label,
      geometryType,
      expectedAnchorCount: definition.anchors.length,
      matchedAnchorCount: items.length,
      pairwise: pairwiseStats(items),
    };

    if (items.length !== definition.anchors.length || items.some((item) => !finiteVector(item.vector))) {
      analyses.push({ ...base, valid: false, reason: "incomplete_or_invalid_vectors" });
      continue;
    }

    const geometry =
      geometryType === "bipolar"
        ? analyzeBipolarAxis(items, origin)
        : analyzePrototypeAxis(items, origin);
    analyses.push({ ...base, ...geometry });
  }

  return analyses;
}

function analyzeAxisRelationships(axisAnalyses) {
  const usable = axisAnalyses.filter((axis) => axis.valid && finiteVector(axis.direction));
  const pairs = [];
  for (let left = 0; left < usable.length; left += 1) {
    for (let right = left + 1; right < usable.length; right += 1) {
      pairs.push({
        left: usable[left].axis,
        right: usable[right].axis,
        leftLayer: usable[left].layer,
        rightLayer: usable[right].layer,
        cosine: round(cosine(usable[left].direction, usable[right].direction)),
      });
    }
  }
  return pairs.sort((left, right) => Math.abs(right.cosine) - Math.abs(left.cosine));
}

function summarizeDimensions(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = row.vectorDimension == null ? "invalid" : String(row.vectorDimension);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

function markdownTable(headers, rows) {
  const escape = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

function buildMarkdown(report) {
  const lines = [];
  lines.push(`# OpenHerPersona 向量基线测试报告：${report.agent}`);
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 数据库：\`${report.databasePath}\``);
  lines.push(`- 模型：\`${report.modelSig || "N/A"}\``);
  lines.push(`- 当前标准锚点：${report.integrity.expectedCount}`);
  lines.push(`- 精确匹配：${report.integrity.matchedCount}`);
  lines.push(`- 缺失：${report.integrity.missingCount}`);
  lines.push(`- 当前模型历史/多余记录：${report.integrity.historicalCount}`);
  lines.push(`- 向量维度：${report.vectorDimension || "N/A"}`);
  lines.push(`- 完整性结论：**${report.integrity.complete ? "PASS" : "FAIL"}**`);
  lines.push("");
  lines.push("> 本报告由只读测试脚本生成。所有校准系数均为诊断数据，不会自动修改运行时或数据库。");
  lines.push("");

  lines.push("## 1. 数据完整性");
  lines.push("");
  lines.push(
    markdownTable(
      ["项目", "数量"],
      [
        ["数据库中该 Agent 全部记录", report.integrity.databaseRowCount],
        ["选定模型记录", report.integrity.selectedModelRowCount],
        ["源码标准锚点", report.integrity.expectedCount],
        ["精确匹配标准锚点", report.integrity.matchedCount],
        ["缺失标准锚点", report.integrity.missingCount],
        ["重复标准锚点", report.integrity.duplicateCurrentCount],
        ["历史/多余锚点", report.integrity.historicalCount],
        ["无效向量", report.integrity.invalidVectorCount],
      ]
    )
  );
  lines.push("");

  if (report.missing.length) {
    lines.push("### 缺失标准锚点");
    lines.push("");
    for (const item of report.missing) lines.push(`- \`${item.layer}/${item.axis}/${item.subAxis}\`：${item.text}`);
    lines.push("");
  }

  if (report.historical.length) {
    lines.push("### 历史/多余锚点");
    lines.push("");
    lines.push(
      markdownTable(
        ["层", "轴", "子轴", "文本", "更新时间"],
        report.historical.map((item) => [item.layer, item.axis, item.subAxis, item.text, item.updatedAt])
      )
    );
    lines.push("");
  }

  lines.push("## 2. 原点");
  lines.push("");
  lines.push(`全体 ${report.integrity.matchedCount} 条当前标准锚点的质心作为本报告全局经验原点。`);
  lines.push("");
  lines.push(`- 原点范数：\`${report.origin.norm}\``);
  lines.push(`- 原点维度：\`${report.origin.dimension}\``);
  lines.push(`- 标准锚点源哈希：\`${report.sourceAnchorHash}\``);
  lines.push("");

  lines.push("## 3. 二极轴校准");
  lines.push("");
  const bipolar = report.axes.filter((axis) => axis.geometryType === "bipolar");
  lines.push(
    markdownTable(
      ["轴", "男性半径", "女性半径", "中点偏置", "偏向", "男性系数", "女性系数", "两极余弦"],
      bipolar.map((axis) => [
        axis.axis,
        axis.masculineRadius,
        axis.feminineRadius,
        axis.midpointBias,
        axis.biasToward,
        axis.masculineCorrection,
        axis.feminineCorrection,
        axis.pairCosine,
      ])
    )
  );
  lines.push("");

  lines.push("## 4. 多原型与混合轴");
  lines.push("");
  const prototypes = report.axes.filter((axis) => axis.geometryType !== "bipolar");
  lines.push(
    markdownTable(
      ["层", "轴", "类型", "锚点", "中心范数", "目标半径", "径向标准差", "横向均值", "异常原型"],
      prototypes.map((axis) => [
        axis.layer,
        axis.axis,
        axis.geometryType,
        `${axis.matchedAnchorCount}/${axis.expectedAnchorCount}`,
        axis.centroidNorm,
        axis.targetRadius,
        axis.radialStd,
        axis.transverseMean,
        Array.isArray(axis.prototypes) ? axis.prototypes.filter((item) => item.outlier).length : "N/A",
      ])
    )
  );
  lines.push("");

  for (const axis of prototypes) {
    lines.push(`### ${axis.axis}（${axis.label}）`);
    lines.push("");
    if (!axis.valid || !Array.isArray(axis.prototypes)) {
      lines.push(`- 无法分析：${axis.reason || "unknown"}`);
      lines.push("");
      continue;
    }
    lines.push(
      markdownTable(
        ["子轴", "半径", "修正系数", "横向偏离", "方向余弦", "异常"],
        axis.prototypes.map((item) => [
          item.subAxis,
          item.radius,
          item.correction,
          item.transverseOffset,
          item.cosineToDirection,
          item.outlier ? "YES" : "",
        ])
      )
    );
    lines.push("");
  }

  lines.push("## 5. 轴间方向重叠");
  lines.push("");
  lines.push("按方向余弦绝对值排序。高重叠可能意味着 embedding 已隐式耦合，需与显式耦合规则联合审查。");
  lines.push("");
  lines.push(
    markdownTable(
      ["轴 A", "层 A", "轴 B", "层 B", "方向余弦"],
      report.axisRelationships.slice(0, 40).map((pair) => [
        pair.left,
        pair.leftLayer,
        pair.right,
        pair.rightLayer,
        pair.cosine,
      ])
    )
  );
  lines.push("");

  lines.push("## 6. 结论边界");
  lines.push("");
  lines.push("- 本报告可测量锚点几何不平衡、轴内尺度差、横向偏离、重复度和轴间重叠。");
  lines.push("- 本报告不能仅凭锚点确定真实会话语言的中性零点、假阳性率或最终激活阈值。");
  lines.push("- `mixed_polarity` 与 `multi_directional` 轴只提供统一几何诊断，正式评分前仍需专门建模。");
  lines.push("- 所有系数均应写入独立校准数据，禁止覆写原始 embedding。");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const definitions = loadAxisDefinitions();
  const expected = buildExpectedAnchors(definitions, options.agent);
  const rawRows = queryDatabase(options.dbPath, options.agent);
  const parsedRows = parseRows(rawRows);
  const modelSig = chooseModelSig(parsedRows, options.modelSig);
  if (!modelSig) throw new Error(`No anchor vectors found for agent ${options.agent}`);

  const matched = matchCurrentAnchors(expected, parsedRows, modelSig);
  const validCurrent = matched.current.filter((item) => finiteVector(item.vector));
  const dimensions = [...new Set(validCurrent.map((item) => item.vector.length))];
  const vectorDimension = dimensions.length === 1 ? dimensions[0] : null;
  const origin = validCurrent.length ? meanVector(validCurrent.map((item) => item.vector)) : [];
  const axes = analyzeAxes(definitions, matched.current, origin);
  const axisRelationships = analyzeAxisRelationships(axes);
  const invalidVectorCount = matched.selectedRows.filter((row) => !row.vectorValid).length;
  const complete =
    matched.missing.length === 0 &&
    matched.duplicateCurrent.length === 0 &&
    invalidVectorCount === 0 &&
    vectorDimension != null &&
    validCurrent.length === expected.length;

  const sourceAnchorPayload = expected.map((item) => {
    const current = matched.current.find(
      (entry) =>
        entry.layer === item.layer &&
        entry.axis === item.axis &&
        entry.subAxis === item.subAxis &&
        entry.text === item.text
    );
    return {
      layer: item.layer,
      axis: item.axis,
      subAxis: item.subAxis,
      text: item.text,
      vector: current && finiteVector(current.vector) ? current.vector : null,
    };
  });

  const report = {
    schemaVersion: 1,
    reportType: "openher_vector_baseline_geometry",
    generatedAt: new Date().toISOString(),
    agent: options.agent,
    databasePath: path.relative(process.cwd(), options.dbPath).replace(/\\/g, "/"),
    sourcePath: path.relative(process.cwd(), SOURCE_PATH).replace(/\\/g, "/"),
    modelSig,
    vectorDimension,
    sourceAnchorHash: hashPayload(sourceAnchorPayload),
    integrity: {
      complete,
      databaseRowCount: parsedRows.length,
      selectedModelRowCount: matched.selectedRows.length,
      expectedCount: expected.length,
      matchedCount: matched.current.length,
      missingCount: matched.missing.length,
      duplicateCurrentCount: matched.duplicateCurrent.length,
      historicalCount: matched.historical.length,
      invalidVectorCount,
      dimensions: summarizeDimensions(matched.selectedRows),
    },
    origin: {
      method: "centroid_of_all_current_standard_anchors",
      dimension: origin.length,
      norm: round(norm(origin)),
      vector: origin,
    },
    missing: matched.missing,
    duplicateCurrent: matched.duplicateCurrent,
    historical: matched.historical,
    axes,
    axisRelationships,
  };

  fs.mkdirSync(options.reportDir, { recursive: true });
  const safeAgent = options.agent.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const jsonPath = path.join(options.reportDir, `${safeAgent}-vector-baseline-report.json`);
  const markdownPath = path.join(options.reportDir, `${safeAgent}-vector-baseline-report.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, buildMarkdown(report), "utf8");

  console.log(
    JSON.stringify(
      {
        status: complete ? "success" : "incomplete",
        agent: options.agent,
        modelSig,
        expectedAnchors: expected.length,
        matchedAnchors: matched.current.length,
        historicalAnchors: matched.historical.length,
        missingAnchors: matched.missing.length,
        invalidVectors: invalidVectorCount,
        vectorDimension,
        jsonReport: path.relative(process.cwd(), jsonPath).replace(/\\/g, "/"),
        markdownReport: path.relative(process.cwd(), markdownPath).replace(/\\/g, "/"),
      },
      null,
      2
    )
  );

  if (!complete) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(`[OpenHerPersonaBaselineAnalysis] ${error.stack || error.message}`);
  process.exitCode = 1;
}