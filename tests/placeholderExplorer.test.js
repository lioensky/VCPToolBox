"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  parseEnvContent,
} = require("../Plugin/PlaceholderExplorer/modules/envScanner");
const {
  atomicValidatedWrite,
  serializeEnvValue,
  validateEnvContent,
} = require("../Plugin/PlaceholderExplorer/modules/editor");
const {
  buildIndex,
} = require("../Plugin/PlaceholderExplorer/modules/indexStore");
const {
  extractPlaceholders,
} = require("../Plugin/PlaceholderExplorer/modules/usageScanner");

async function makeTempProject() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "placeholder-explorer-")
  );
  await fs.mkdir(path.join(root, "Plugin", "PlaceholderExplorer"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, "TVStxt"), { recursive: true });
  return root;
}

test("envScanner 保留多行值并给出定义行号与文件指向", () => {
  const content = [
    "# comment",
    'TarRoot="line1',
    '{{VarNested}}"',
    "VarNested=nested.txt",
  ].join("\n");
  const parsed = parseEnvContent(content, {
    projectRoot: "C:/project",
    tvsDir: "C:/project/TVStxt",
  });
  const tar = parsed.entries.find((item) => item.key === "TarRoot");
  const variable = parsed.entries.find((item) => item.key === "VarNested");
  assert.equal(tar.startLine, 2);
  assert.equal(tar.endLine, 3);
  assert.match(tar.value, /\{\{VarNested\}\}/);
  assert.equal(variable.resolvesTo.replace(/\\/g, "/"), "TVStxt/nested.txt");
});

test("usageScanner 提取花括号和方括号占位符行号", () => {
  const references = extractPlaceholders(
    "a {{VarA}}\nb [[角色日记本]]",
    "Agent/A.txt",
    "agent"
  );
  assert.deepEqual(
    references.map((item) => [item.placeholder, item.line]),
    [
      ["{{VarA}}", 1],
      ["[[角色日记本]]", 2],
    ]
  );
});

test("indexStore 构建递归引用链并检测死链", () => {
  const index = buildIndex({
    projectRoot: "C:/project",
    definitions: [
      {
        placeholder: "{{TarRoot}}",
        type: "tar",
        file: "config.env",
        line: 1,
        resolvesTo: "TVStxt/root.txt",
        editable: true,
      },
      {
        placeholder: "{{VarChild}}",
        type: "var",
        file: "config.env",
        line: 2,
        resolvesTo: "TVStxt/child.txt",
        editable: true,
      },
    ],
    references: [
      { placeholder: "{{VarChild}}", file: "TVStxt/root.txt", line: 1 },
      { placeholder: "{{Missing}}", file: "TVStxt/child.txt", line: 1 },
    ],
  });
  const root = index.entries.find((item) => item.placeholder === "{{TarRoot}}");
  assert.deepEqual(root.referenceChains[0].path, [
    "{{TarRoot}}",
    "TVStxt/root.txt",
    "{{VarChild}}",
    "TVStxt/child.txt",
    "{{Missing}}",
  ]);
  assert.ok(
    index.checks.deadLinks.some((item) => item.placeholder === "{{Missing}}")
  );

  const manifestOnly = buildIndex({
    references: [
      {
        placeholder: "{{EXAMPLE_TOKEN}}",
        file: "Plugin/X/plugin-manifest.json",
        line: 3,
        source: "plugin_manifest",
      },
    ],
  });
  assert.equal(manifestOnly.checks.deadLinks.length, 0);
});

test("indexStore 将内置开关和预处理器协议识别为运行时定义", () => {
  const runtimePlaceholders = [
    "[[AIMemo=True]]",
    "[[AIMemo=False]]",
    "[[VCPStaticFold::Auto]]",
    "[[VCPStaticFold::Lite]]",
    "[[VCPStaticFold::Full]]",
    "[[VCPTimeLine::Agent]]",
    "[[VCPTimeLine::Agent:K:Threshold]]",
  ];
  const index = buildIndex({
    references: runtimePlaceholders.map((placeholder, offset) => ({
      placeholder,
      file: "Agent/Test.txt",
      line: offset + 1,
      source: "agent",
    })),
  });

  for (const placeholder of runtimePlaceholders) {
    const entry = index.entries.find((item) => item.placeholder === placeholder);
    assert.equal(entry?.type, "runtime_dynamic", placeholder);
    assert.equal(entry?.definitions.length, 1, placeholder);
    assert.equal(
      index.checks.deadLinks.some((item) => item.placeholder === placeholder),
      false,
      placeholder
    );
  }
});

test("indexStore 不会宽泛豁免未知 VCP 方括号协议", () => {
  const placeholder = "[[VCPUnknown::Value]]";
  const index = buildIndex({
    references: [
      {
        placeholder,
        file: "Agent/Test.txt",
        line: 1,
        source: "agent",
      },
    ],
  });

  assert.ok(
    index.checks.deadLinks.some((item) => item.placeholder === placeholder)
  );
});

test("atomicValidatedWrite 先备份再替换并清理临时文件", async () => {
  const root = await makeTempProject();
  const pluginDir = path.join(root, "Plugin", "PlaceholderExplorer");
  const backupRoot = path.join(pluginDir, "backups");
  const envPath = path.join(root, "config.env");
  await fs.writeFile(envPath, "VarCity=Old\n", "utf8");
  const value = "New City";
  const nextContent = `VarCity=${serializeEnvValue(value)}\n`;
  const result = await atomicValidatedWrite(envPath, nextContent, {
    projectRoot: root,
    pluginDir,
    backupRoot,
    backupRetention: 5,
    validate: (content) =>
      validateEnvContent(content, "VarCity", value, {
        projectRoot: root,
        tvsDir: path.join(root, "TVStxt"),
      }),
  });
  assert.equal(await fs.readFile(envPath, "utf8"), nextContent);
  assert.equal(
    await fs.readFile(path.join(pluginDir, result.backup), "utf8"),
    "VarCity=Old\n"
  );
  const directoryEntries = await fs.readdir(root);
  assert.equal(
    directoryEntries.some((name) => name.includes(".tmp")),
    false
  );
});

test("atomicValidatedWrite 校验失败不改原文件且不产生备份", async () => {
  const root = await makeTempProject();
  const pluginDir = path.join(root, "Plugin", "PlaceholderExplorer");
  const backupRoot = path.join(pluginDir, "backups");
  const envPath = path.join(root, "config.env");
  await fs.writeFile(envPath, "VarCity=Old\n", "utf8");
  await assert.rejects(
    () =>
      atomicValidatedWrite(envPath, "broken", {
        projectRoot: root,
        pluginDir,
        backupRoot,
        validate: () => {
          throw new Error("invalid");
        },
      }),
    /invalid/
  );
  assert.equal(await fs.readFile(envPath, "utf8"), "VarCity=Old\n");
  await assert.rejects(() => fs.access(backupRoot));
});
