"use strict";

const fs = require("fs").promises;
const path = require("path");
const { normalizePlaceholder, pathExists } = require("./pathUtils");

function uniqueLocations(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.file}:${item.line || 0}:${item.source || ""}:${
      item.value || ""
    }`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function innerName(placeholder) {
  return String(placeholder || "")
    .replace(/^\{\{|\}\}$/g, "")
    .replace(/^\[\[|\]\]$/g, "");
}

function isDiaryDeclaration(placeholder) {
  const inner = innerName(placeholder);
  return /(日记本|知识库)/.test(inner) || /^VCP元思考/.test(inner);
}

function isRuntimePattern(placeholder) {
  const inner = innerName(placeholder);
  return (
    /^VCP_ASYNC_RESULT::/.test(inner) ||
    /^VCPTavern::/.test(inner) ||
    /^AIMemo=(?:True|False)$/i.test(inner) ||
    /^VCPStaticFold::(?:Auto|Lite|Full)$/i.test(inner) ||
    /^VCPTimeLine::[^:\]\r\n]+(?::[^:\]\r\n]+){0,2}$/i.test(inner)
  );
}

function buildReferenceChains(
  rootPlaceholder,
  definitionsByPlaceholder,
  referencesByFile
) {
  const edges = [];
  const chains = [];

  function walk(placeholder, pathParts, visited) {
    const definitions = definitionsByPlaceholder.get(placeholder) || [];
    const fileDefinitions = definitions.filter((item) => item.resolvesTo);
    if (fileDefinitions.length === 0) {
      chains.push({ path: pathParts, cycle: false });
      return;
    }
    for (const definition of fileDefinitions) {
      const refs = referencesByFile.get(definition.resolvesTo) || [];
      const contains = [...new Set(refs.map((item) => item.placeholder))];
      edges.push({ from: placeholder, to: definition.resolvesTo, contains });
      if (contains.length === 0) {
        chains.push({
          path: [...pathParts, definition.resolvesTo],
          cycle: false,
        });
        continue;
      }
      for (const child of contains) {
        const nextPath = [...pathParts, definition.resolvesTo, child];
        if (visited.has(child)) {
          chains.push({ path: nextPath, cycle: true });
          continue;
        }
        if (
          (definitionsByPlaceholder.get(child) || []).some(
            (item) => item.resolvesTo
          )
        ) {
          const nextVisited = new Set(visited);
          nextVisited.add(child);
          walk(child, nextPath, nextVisited);
        } else {
          chains.push({ path: nextPath, cycle: false });
        }
      }
    }
  }

  walk(rootPlaceholder, [rootPlaceholder], new Set([rootPlaceholder]));
  const edgeSeen = new Set();
  return {
    nesting: edges.filter((edge) => {
      const key = `${edge.from}->${edge.to}`;
      if (edgeSeen.has(key)) return false;
      edgeSeen.add(key);
      return true;
    }),
    referenceChains: chains,
  };
}

function buildIndex({
  definitions = [],
  references = [],
  errors = [],
  projectRoot = "",
  lastScan = new Date().toISOString(),
} = {}) {
  const definitionsByPlaceholder = new Map();
  const referencesByPlaceholder = new Map();
  const referencesByFile = new Map();

  for (const definition of definitions) {
    const placeholder = definition.placeholder.startsWith("[[")
      ? definition.placeholder
      : normalizePlaceholder(definition.placeholder);
    if (!definitionsByPlaceholder.has(placeholder))
      definitionsByPlaceholder.set(placeholder, []);
    definitionsByPlaceholder
      .get(placeholder)
      .push({ ...definition, placeholder: undefined });
  }

  for (const reference of references) {
    const placeholder = reference.placeholder.startsWith("[[")
      ? reference.placeholder
      : normalizePlaceholder(reference.placeholder);
    const normalized = { ...reference, placeholder: undefined };
    if (!referencesByPlaceholder.has(placeholder))
      referencesByPlaceholder.set(placeholder, []);
    referencesByPlaceholder.get(placeholder).push(normalized);
    if (!referencesByFile.has(reference.file))
      referencesByFile.set(reference.file, []);
    referencesByFile.get(reference.file).push({ ...reference, placeholder });

    if (
      !definitionsByPlaceholder.has(placeholder) &&
      isRuntimePattern(placeholder)
    ) {
      definitionsByPlaceholder.set(placeholder, [
        {
          type: "runtime_dynamic",
          file: reference.file,
          line: reference.line,
          value: "由 VCP 内置功能或消息预处理器消费的运行时协议",
          resolvesTo: null,
          editable: false,
          source: "runtime_pattern",
        },
      ]);
    } else if (
      !definitionsByPlaceholder.has(placeholder) &&
      isDiaryDeclaration(placeholder)
    ) {
      definitionsByPlaceholder.set(placeholder, [
        {
          type: "diary_declared",
          file: reference.file,
          line: reference.line,
          value: "由 Agent 提示词现场声明并由日记/知识库处理器解析",
          resolvesTo: null,
          editable: false,
          source: "declaration",
        },
      ]);
    }
  }

  const placeholders = new Set([
    ...definitionsByPlaceholder.keys(),
    ...referencesByPlaceholder.keys(),
  ]);
  const entries = [...placeholders]
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((placeholder) => {
      const itemDefinitions = uniqueLocations(
        definitionsByPlaceholder.get(placeholder) || []
      );
      const itemReferences = uniqueLocations(
        referencesByPlaceholder.get(placeholder) || []
      ).filter(
        (reference) =>
          !itemDefinitions.some(
            (definition) =>
              definition.file === reference.file &&
              definition.line === reference.line
          )
      );
      const type = itemDefinitions[0]?.type || "undefined";
      const editable = itemDefinitions.some(
        (definition) => definition.editable === true
      );
      const chainData = itemDefinitions.some(
        (definition) => definition.resolvesTo
      )
        ? buildReferenceChains(
            placeholder,
            definitionsByPlaceholder,
            referencesByFile
          )
        : { nesting: [], referenceChains: [] };
      return {
        placeholder,
        type,
        definitions: itemDefinitions,
        references: itemReferences,
        nesting: chainData.nesting,
        referenceChains: chainData.referenceChains,
        editable,
        lastScan,
      };
    });

  const deadLinks = entries
    .filter((item) => item.definitions.length === 0)
    .filter((item) =>
      item.references.some(
        (reference) => reference.source !== "plugin_manifest"
      )
    )
    .map((item) => ({
      placeholder: item.placeholder,
      references: item.references,
    }));
  const orphans = entries
    .filter(
      (item) => item.definitions.length > 0 && item.references.length === 0
    )
    .filter((item) => item.type !== "diary_declared")
    .map((item) => ({
      placeholder: item.placeholder,
      type: item.type,
      definitions: item.definitions,
    }));

  return {
    schemaVersion: 1,
    generatedAt: lastScan,
    projectRoot,
    stats: {
      placeholders: entries.length,
      definitions: entries.reduce(
        (sum, item) => sum + item.definitions.length,
        0
      ),
      references: entries.reduce(
        (sum, item) => sum + item.references.length,
        0
      ),
      deadLinks: deadLinks.length,
      orphans: orphans.length,
      scanErrors: errors.length,
    },
    entries,
    checks: { deadLinks, orphans },
    errors,
  };
}

async function saveIndex(indexPath, index) {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, indexPath);
  return indexPath;
}

async function loadIndex(indexPath) {
  if (!(await pathExists(indexPath))) return null;
  return JSON.parse(await fs.readFile(indexPath, "utf8"));
}

function locate(index, placeholder) {
  if (!index || !Array.isArray(index.entries)) return null;
  const normalized = String(placeholder || "")
    .trim()
    .startsWith("[[")
    ? String(placeholder).trim()
    : normalizePlaceholder(placeholder);
  return index.entries.find((item) => item.placeholder === normalized) || null;
}

module.exports = { buildIndex, loadIndex, locate, saveIndex };
