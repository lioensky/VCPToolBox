// --- 模块导入（ESM 语法）---
import { createRequire } from 'module';
import * as fs from 'fs/promises';
import * as path from 'path';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const { MidiQuantizer } = require('./midi_quantizer.node');

let serverConfig = {};
let pluginConfig = {};  // 新增：插件配置存储
let sendVcpLog;

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const inputDir = path.join(__dirname, 'midi-input');
const defaultOutputDir = path.join(__dirname, 'midi-output');  // 默认目录

// 获取最终输出目录的辅助函数
function getOutputDirectory() {
  const mode = pluginConfig.OUTPUT_MODE || 'default';
  
  switch (mode) {
    case 'server':
      // 服务器模式：使用配置的根目录
      return pluginConfig.SERVER_ROOT || defaultOutputDir;
    
    case 'custom':
      // 自定义模式：支持绝对路径和相对路径
      if (!pluginConfig.CUSTOM_PATH) return defaultOutputDir;
      
      // 如果是绝对路径，直接使用；否则相对于插件目录
      return path.isAbsolute(pluginConfig.CUSTOM_PATH)
        ? pluginConfig.CUSTOM_PATH
        : path.resolve(__dirname, pluginConfig.CUSTOM_PATH);
    
    default:
      // 默认模式：使用插件内置目录
      return defaultOutputDir;
  }
}

function rustSafe(call) {
  try {
    return { ok: true, data: call() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function initialize(config, services) {
    sendVcpLog = services?.sendVcpLog;
    try {
        // --- 新增：加载插件配置 ---
        const pluginEnvPath = path.join(__dirname, 'config.env');
        try {
            const pluginEnvContent = await fs.readFile(pluginEnvPath, 'utf-8');
            pluginConfig = dotenv.parse(pluginEnvContent);
            console.log('[MIDITranslator] 配置加载成功:', {
                outputMode: pluginConfig.OUTPUT_MODE || 'default',
                outputPath: getOutputDirectory()
            });
        } catch (e) {
            console.log('[MIDITranslator] 未找到 config.env，使用默认配置');
            pluginConfig = {};
        }

        // 确保必要的目录存在
        await fs.mkdir(inputDir, { recursive: true });
        await fs.mkdir(getOutputDirectory(), { recursive: true });
        
        console.log('[MIDITranslator] 插件初始化完成');
    } catch (error) {
        console.error('[MIDITranslator] 初始化错误:', error);
    }
}

async function processToolCall(args) {
    const { command, ...params } = args;
    try {
        switch (command) {
            case 'parse_midi': return await handleParseMidi(params);
            case 'generate_midi': return await handleGenerateMidi(params);
            case 'list_midi_files': return await handleListMidiFiles(params);
            case 'validate_dsl': return await handleValidateDSL(params);
            default: return { status: 'error', error: `未知命令: ${command}` };
        }
    } catch (error) { return { status: 'error', error: error.message }; }
}

async function handleParseMidi(params) {
    const { fileName, hexData } = params;
    try {
        let midiData;
        let sourceName;

        if (hexData) {
            midiData = Buffer.from(hexData, 'hex');
            sourceName = "Hex_Stream";
        } else if (fileName) {
            const filePath = path.isAbsolute(fileName) ? fileName : path.join(inputDir, fileName);
            await fs.access(filePath);
            midiData = await fs.readFile(filePath);
            sourceName = path.basename(filePath);
        } else {
            return { status: 'error', error: '缺少 fileName 或 hexData' };
        }
        
        const quantizer = new MidiQuantizer();
        const res = rustSafe(() => quantizer.quantize(midiData));
        if (!res.ok) return { status: 'error', error: res.error };
        
        return { 
            status: 'success', 
            result: `[MIDITranslator] 解析成功！\n来源: ${sourceName}\n大小: ${midiData.length} 字节`,
            dsl: res.data
        };
    } catch (error) { return { status: 'error', error: `解析失败: ${error.message}` }; }
}

async function handleGenerateMidi(params) {
  const { dslContent, outputFileName } = params;
  if (!dslContent) return { status: 'error', error: '缺少 dslContent' };

  try {
    const quantizer = new MidiQuantizer();
    const res = rustSafe(() => quantizer.generate(dslContent));
    if (!res.ok) return { status: 'error', error: res.error };
    
    const midiBuffer = res.data;
    const finalFileName = outputFileName || `gen_${Date.now()}.mid`;
    
    // --- 修改核心：动态获取输出目录 ---
    const outputDirectory = getOutputDirectory();
    const outputPath = path.join(outputDirectory, finalFileName);
    
    // 确保目标目录存在（对于 custom 模式可能尚未创建）
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(outputPath, Buffer.from(midiBuffer));

    return {
      status: 'success',
      result: `[MIDITranslator] 生成成功！\n路径: ${outputPath}\n大小: ${midiBuffer.length} 字节`,
      outputPath,
      fileName: finalFileName
    };
  } catch (error) { return { status: 'error', error: error.message }; }
}

async function handleListMidiFiles() {
    const inputFiles = await fs.readdir(inputDir);
    return { status: 'success', result: `输入目录文件: ${inputFiles.join(', ')}` };
}

async function handleValidateDSL(params) {
    const quantizer = new MidiQuantizer();
    return { status: 'success', isValid: quantizer.validate_dsl(params.dslContent) };
}

export { initialize, processToolCall };