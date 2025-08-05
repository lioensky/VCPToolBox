#!/usr/bin/env node
// 工作流模板转换CLI工具

const fs = require('fs-extra');
const path = require('path');
const WorkflowTemplateProcessor = require('./WorkflowTemplateProcessor');

class WorkflowTemplateCLI {
    constructor() {
        this.processor = new WorkflowTemplateProcessor();
    }

    /**
     * 显示帮助信息
     */
    showHelp() {
        console.log(`
ComfyUI 工作流模板转换工具

用法:
  node workflow-template-cli.js <command> [options]

命令:
  convert <input> <output>        将原始工作流转换为模板
  validate <template>             验证模板有效性
  analyze <workflow>              分析工作流结构
  placeholders <template>         列出模板中的占位符

示例:
  # 将原始工作流转换为模板
  node workflow-template-cli.js convert workflows/示例.json templates/示例-template.json

  # 验证模板
  node workflow-template-cli.js validate templates/示例-template.json

  # 分析工作流结构
  node workflow-template-cli.js analyze workflows/示例.json

注意: 模板填充功能请使用主程序 ComfyUIGen.js
        `);
    }

    /**
     * 转换工作流为模板
     */
    async convertToTemplate(inputPath, outputPath) {
        try {
            console.log(`[CLI] Converting workflow to template...`);
            console.log(`[CLI] Input: ${inputPath}`);
            console.log(`[CLI] Output: ${outputPath}`);

            // 读取原始工作流
            const workflow = await fs.readJson(inputPath);
            
            // 转换为模板
            const template = this.processor.convertToTemplate(workflow);
            
            // 保存模板
            await this.processor.saveTemplate(template, outputPath);
            
            console.log(`[CLI] ✅ Template conversion completed successfully!`);
            console.log(`[CLI] Replacements made: ${template._template_metadata.replacementsMade.length}`);
            console.log(`[CLI] Preserved nodes: ${template._template_metadata.preservedNodes.length}`);
            
            return { success: true };
        } catch (error) {
            console.error(`[CLI] ❌ Conversion failed:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * 验证模板
     */
    async validateTemplate(templatePath) {
        try {
            console.log(`[CLI] Validating template...`);
            console.log(`[CLI] Template: ${templatePath}`);

            const template = await this.processor.loadTemplate(templatePath);
            const validation = this.processor.validateTemplate(template);
            
            if (validation.isValid) {
                console.log(`[CLI] ✅ Template is valid!`);
            } else {
                console.log(`[CLI] ❌ Template validation failed!`);
                console.log(`[CLI] Errors:`, validation.errors);
            }
            
            if (validation.warnings.length > 0) {
                console.log(`[CLI] ⚠️  Warnings:`, validation.warnings);
            }
            
            return validation;
        } catch (error) {
            console.error(`[CLI] ❌ Template validation failed:`, error.message);
            return { isValid: false, errors: [error.message], warnings: [] };
        }
    }

    /**
     * 分析工作流结构
     */
    async analyzeWorkflow(workflowPath) {
        try {
            console.log(`[CLI] Analyzing workflow structure...`);
            console.log(`[CLI] Workflow: ${workflowPath}`);

            const workflow = await fs.readJson(workflowPath);
            
            const nodeTypes = {};
            const totalNodes = Object.keys(workflow).length;
            
            for (const [nodeId, node] of Object.entries(workflow)) {
                if (node.class_type) {
                    nodeTypes[node.class_type] = (nodeTypes[node.class_type] || 0) + 1;
                }
            }
            
            console.log(`[CLI] ✅ Workflow analysis completed!`);
            console.log(`[CLI] Total nodes: ${totalNodes}`);
            console.log(`[CLI] Node types:`);
            
            for (const [classType, count] of Object.entries(nodeTypes)) {
                console.log(`[CLI]   ${classType}: ${count}`);
            }
            
            return { totalNodes, nodeTypes };
        } catch (error) {
            console.error(`[CLI] ❌ Workflow analysis failed:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * 列出模板占位符
     */
    async listPlaceholders(templatePath) {
        try {
            console.log(`[CLI] Listing template placeholders...`);
            console.log(`[CLI] Template: ${templatePath}`);

            const template = await this.processor.loadTemplate(templatePath);
            const placeholders = this.processor.getTemplatePlaceholders(template);
            
            console.log(`[CLI] ✅ Found ${placeholders.length} placeholders:`);
            placeholders.forEach(placeholder => {
                console.log(`[CLI]   ${placeholder}`);
            });
            
            return placeholders;
        } catch (error) {
            console.error(`[CLI] ❌ Placeholder listing failed:`, error.message);
            return [];
        }
    }

    /**
     * 运行CLI
     */
    async run() {
        const args = process.argv.slice(2);
        
        if (args.length === 0) {
            this.showHelp();
            return;
        }
        
        const command = args[0];
        
        switch (command) {
            case 'convert':
                if (args.length < 3) {
                    console.error('[CLI] Error: convert command requires input and output paths');
                    return;
                }
                await this.convertToTemplate(args[1], args[2]);
                break;
                
            case 'validate':
                if (args.length < 2) {
                    console.error('[CLI] Error: validate command requires template path');
                    return;
                }
                await this.validateTemplate(args[1]);
                break;
                
            case 'analyze':
                if (args.length < 2) {
                    console.error('[CLI] Error: analyze command requires workflow path');
                    return;
                }
                await this.analyzeWorkflow(args[1]);
                break;
                
            case 'placeholders':
                if (args.length < 2) {
                    console.error('[CLI] Error: placeholders command requires template path');
                    return;
                }
                await this.listPlaceholders(args[1]);
                break;
                
            case 'help':
            case '--help':
            case '-h':
                this.showHelp();
                break;
                
            default:
                console.error(`[CLI] Error: Unknown command '${command}'`);
                console.error(`[CLI] Note: Template filling is now handled by ComfyUIGen.js main program`);
                this.showHelp();
        }
    }
}

// 如果直接运行此文件，则执行CLI
if (require.main === module) {
    const cli = new WorkflowTemplateCLI();
    cli.run().catch(error => {
        console.error('[CLI] Fatal error:', error);
        process.exit(1);
    });
}

module.exports = WorkflowTemplateCLI;