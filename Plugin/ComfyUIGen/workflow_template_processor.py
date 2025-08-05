#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ComfyUI工作流模板转换工具 - Python版本
用于没有前端界面的用户直接转换ComfyUI工作流

作者: Claude
日期: 2025-08-04
"""

import json
import os
import sys
import re
import argparse
from pathlib import Path
from typing import Dict, List, Any, Optional
from datetime import datetime

# 设置输出编码
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

class WorkflowTemplateProcessor:
    """ComfyUI工作流模板处理器 - 与JavaScript版本保持一致"""
    
    def __init__(self):
        # 节点类型到替换字段的映射
        self.node_type_mapping = {
            'KSampler': {
                'replacements': {
                    'seed': '{{SEED}}',
                    'steps': '{{STEPS}}',
                    'cfg': '{{CFG}}',
                    'sampler_name': '{{SAMPLER}}',
                    'scheduler': '{{SCHEDULER}}',
                    'denoise': '{{DENOISE}}'
                }
            },
            'EmptyLatentImage': {
                'replacements': {
                    'width': '{{WIDTH}}',
                    'height': '{{HEIGHT}}',
                    'batch_size': '{{BATCH_SIZE}}'
                }
            },
            'CheckpointLoaderSimple': {
                'replacements': {
                    'ckpt_name': '{{MODEL}}'
                }
            },
            'easy comfyLoader': {
                'replacements': {
                    'ckpt_name': '{{MODEL}}',
                    'lora_name': 'None',  # 我们通过提示词处理LoRA
                    'lora_model_strength': 0.7,
                    'lora_clip_strength': 1.0
                }
            },
            'WeiLinPromptToString': {
                'replacements': {
                    'positive': '{{POSITIVE_PROMPT}}',
                    'negative': '{{NEGATIVE_PROMPT}}'
                }
            },
            'PrimitiveString': {
                # 需要根据title智能判断
                'titleBasedReplacements': {
                    '别动': None,  # 不替换
                    '替换': '{{POSITIVE_PROMPT}}',  # 替换为正面提示词
                    '不替换': None,  # 不替换
                    '伪提示词': '{{PROMPT_INPUT}}',  # 替换为独立的提示词输入
                    '用户提示': '{{USER_PROMPT}}',  # 仅用户输入
                    'default': '{{POSITIVE_PROMPT}}'  # 默认替换
                }
            },
            'CLIPTextEncode': {
                'replacements': {
                    'text': {
                        # 检查是否连接到正面或负面提示词
                        'positive': '{{POSITIVE_PROMPT}}',
                        'negative': '{{NEGATIVE_PROMPT}}'
                    }
                }
            }
        }
        
        # 不需要替换的节点（标记为保持原样）
        self.preserve_nodes = [
            'VAEDecode',
            'SaveImage',
            'UpscaleModelLoader',
            'UltralyticsDetectorProvider',
            'SAMLoader',
            'FaceDetailer'
        ]
    
    def convert_to_template(self, workflow: Dict[str, Any]) -> Dict[str, Any]:
        """将ComfyUI工作流转换为模板"""
        template = json.loads(json.dumps(workflow))  # 深拷贝
        metadata = {
            'originalNodes': {},
            'replacementsMade': [],
            'preservedNodes': []
        }
        
        # 遍历所有节点
        for node_id, node in template.items():
            if not isinstance(node, dict) or 'class_type' not in node:
                continue
                
            class_type = node['class_type']
            
            # 检查是否需要保留原样（通过节点类型）
            if class_type in self.preserve_nodes:
                metadata['preservedNodes'].append({
                    'nodeId': node_id,
                    'classType': class_type,
                    'title': node.get('_meta', {}).get('title', class_type),
                    'reason': 'preserve_node_type'
                })
                continue
            
            # 使用智能处理函数
            self._process_node_intelligently(template[node_id], node_id, metadata)
        
        # 添加模板元数据
        template['_template_metadata'] = {
            'version': '1.0',
            'generatedAt': datetime.now().isoformat(),
            **metadata
        }
        
        return template
    
    def _analyze_node_title(self, node: Dict[str, Any], node_id: str) -> Dict[str, Any]:
        """专门处理节点标识的函数，根据节点的 _meta.title 来决定如何处理"""
        if '_meta' not in node or 'title' not in node['_meta']:
            return {'action': 'default'}  # 没有标识，使用默认处理
        
        title = node['_meta']['title'].lower()
        
        # 特殊的提示词处理（优先级最高）
        if '伪提示词' in title:
            return {'action': 'replace', 'target': 'prompt_input', 'placeholder': '{{PROMPT_INPUT}}'}
        
        if '用户提示' in title:
            return {'action': 'replace', 'target': 'user_prompt', 'placeholder': '{{USER_PROMPT}}'}
        
        # 明确的不处理标识（但要排除特殊情况）
        if ('别动' in title or '不替换' in title or '保持' in title) and '伪提示词' not in title:
            return {'action': 'preserve', 'reason': 'explicit_no_replace'}
        
        # 明确的替换标识
        if '替换' in title or '修改节点' in title:
            return {'action': 'replace', 'target': 'full'}  # 完整替换
        
        # 根据节点类型和标识组合判断
        if node['class_type'] == 'PrimitiveString':
            if '提示词' in title:
                return {'action': 'replace', 'target': 'prompt_input', 'placeholder': '{{PROMPT_INPUT}}'}
        
        if node['class_type'] == 'WeiLinPromptToString':
            if 'lora' in title.lower():
                return {'action': 'preserve', 'reason': 'lora_handler'}  # LoRA处理节点保持原样
        
        # 非修改节点
        if '非修改节点' in title:
            return {'action': 'preserve', 'reason': 'explicit_no_modify'}
        
        # 默认根据节点类型处理
        return {'action': 'default'}
    
    def _process_node_intelligently(self, node: Dict[str, Any], node_id: str, metadata: Dict[str, Any]):
        """智能处理节点替换"""
        analysis = self._analyze_node_title(node, node_id)
        
        # 记录分析结果
        if 'analysisResults' not in metadata:
            metadata['analysisResults'] = []
        metadata['analysisResults'].append({
            'nodeId': node_id,
            'classType': node['class_type'],
            'title': node.get('_meta', {}).get('title'),
            'action': analysis['action'],
            'reason': analysis.get('reason')
        })
        
        if analysis['action'] == 'preserve':
            # 保持原样
            metadata['preservedNodes'].append({
                'nodeId': node_id,
                'classType': node['class_type'],
                'title': node.get('_meta', {}).get('title', node['class_type']),
                'reason': analysis['reason']
            })
            return  # 不做任何修改
        
        if analysis['action'] == 'replace':
            # 执行特定的替换
            if analysis['target'] == 'prompt_input' and 'inputs' in node and 'value' in node['inputs']:
                original_value = node['inputs']['value']
                node['inputs']['value'] = analysis['placeholder']
                metadata['replacementsMade'].append({
                    'nodeId': node_id,
                    'classType': node['class_type'],
                    'inputKey': 'value',
                    'originalValue': original_value,
                    'replacement': analysis['placeholder'],
                    'reason': 'title_based_prompt_input'
                })
                return
        
        # 默认处理 - 使用原有的节点类型映射
        class_type = node['class_type']
        if class_type in self.node_type_mapping:
            self._process_node_by_type(node, self.node_type_mapping[class_type], node_id, metadata)
    
    def _process_node_by_type(self, node: Dict[str, Any], mapping: Dict[str, Any], node_id: str, metadata: Dict[str, Any]):
        """按节点类型处理（原有逻辑）"""
        if 'inputs' not in node or 'replacements' not in mapping:
            return
            
        metadata['originalNodes'][node_id] = json.loads(json.dumps(node['inputs']))
        
        for input_key, replacement in mapping['replacements'].items():
            if input_key in node['inputs']:
                original_value = node['inputs'][input_key]
                
                if isinstance(replacement, str):
                    node['inputs'][input_key] = replacement
                    metadata['replacementsMade'].append({
                        'nodeId': node_id,
                        'classType': node['class_type'],
                        'inputKey': input_key,
                        'originalValue': original_value,
                        'replacement': replacement,
                        'reason': 'node_type_mapping'
                    })
                elif isinstance(replacement, dict):
                    node['inputs'][input_key] = self._process_complex_replacement(original_value, replacement)
                elif isinstance(replacement, (int, float)):
                    node['inputs'][input_key] = replacement
    
    def _process_complex_replacement(self, original_value: Any, replacement_rules: Dict[str, Any]) -> Any:
        """处理复杂的替换逻辑"""
        # 根据上下文决定使用哪种替换
        return replacement_rules.get('positive', replacement_rules.get('default', original_value))

    
    def get_template_placeholders(self, template: Dict[str, Any]) -> List[str]:
        """获取模板中的所有占位符"""
        template_string = json.dumps(template)
        placeholder_pattern = r'\{\{([^}]+)\}\}'
        matches = re.findall(placeholder_pattern, template_string)
        return [f"{{{{{match}}}}}" for match in set(matches)]
    
    def validate_template(self, template: Dict[str, Any]) -> Dict[str, Any]:
        """验证模板的有效性"""
        errors = []
        warnings = []
        
        # 检查是否有模板元数据
        if '_template_metadata' not in template:
            warnings.append('Template does not have metadata')
        
        # 检查是否有必要的占位符
        template_string = json.dumps(template)
        required_placeholders = ['{{MODEL}}', '{{POSITIVE_PROMPT}}']
        
        for placeholder in required_placeholders:
            if placeholder not in template_string:
                errors.append(f'Missing required placeholder: {placeholder}')
        
        return {
            'isValid': len(errors) == 0,
            'errors': errors,
            'warnings': warnings
        }


def find_config_file(start_dir: str = '.') -> Optional[str]:
    """查找配置文件"""
    current_dir = Path(start_dir).resolve()
    
    # 查找可能的配置文件位置
    config_paths = [
        current_dir / 'comfyui-settings.json',
        current_dir / 'VCPToolBox' / 'Plugin' / 'ComfyUIGen' / 'comfyui-settings.json',
        current_dir.parent / 'VCPToolBox' / 'Plugin' / 'ComfyUIGen' / 'comfyui-settings.json',
    ]
    
    for config_path in config_paths:
        if config_path.exists():
            return str(config_path)
    
    return None


def main():
    parser = argparse.ArgumentParser(description='ComfyUI工作流模板转换工具 - 与JavaScript版本保持一致')
    subparsers = parser.add_subparsers(dest='command', help='可用命令')
    
    # 转换命令
    convert_parser = subparsers.add_parser('convert', help='将原始工作流转换为模板')
    convert_parser.add_argument('input', help='输入工作流文件路径')
    convert_parser.add_argument('output', help='输出模板文件路径')
    
    # 验证命令
    validate_parser = subparsers.add_parser('validate', help='验证模板有效性')
    validate_parser.add_argument('template', help='模板文件路径')
    
    # 分析命令
    analyze_parser = subparsers.add_parser('analyze', help='分析工作流结构')
    analyze_parser.add_argument('workflow', help='工作流文件路径')
    
    # 占位符命令
    placeholders_parser = subparsers.add_parser('placeholders', help='列出模板中的占位符')
    placeholders_parser.add_argument('template', help='模板文件路径')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        print('\n注意: 模板填充功能请使用各语言的主程序（如 ComfyUIGen.js）')
        return
    
    processor = WorkflowTemplateProcessor()
    
    try:
        if args.command == 'convert':
            print(f'正在转换工作流: {args.input} -> {args.output}')
            
            # 读取原始工作流
            with open(args.input, 'r', encoding='utf-8') as f:
                workflow = json.load(f)
            
            # 转换为模板
            template = processor.convert_to_template(workflow)
            
            # 保存模板
            os.makedirs(os.path.dirname(args.output), exist_ok=True)
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(template, f, indent=2, ensure_ascii=False)
            
            print(f'✅ 转换完成!')
            print(f'替换数量: {len(template["_template_metadata"]["replacementsMade"])}')
            print(f'保留节点: {len(template["_template_metadata"]["preservedNodes"])}')
        
        elif args.command == 'validate':
            print(f'正在验证模板: {args.template}')
            
            # 读取模板
            with open(args.template, 'r', encoding='utf-8') as f:
                template = json.load(f)
            
            # 验证模板
            validation = processor.validate_template(template)
            placeholders = processor.get_template_placeholders(template)
            
            if validation['isValid']:
                print('✅ 模板验证通过!')
            else:
                print('❌ 模板验证失败!')
                for error in validation['errors']:
                    print(f'  错误: {error}')
            
            if validation['warnings']:
                print('⚠️  警告:')
                for warning in validation['warnings']:
                    print(f'  {warning}')
            
            print(f'占位符数量: {len(placeholders)}')
            for placeholder in placeholders:
                print(f'  {placeholder}')
        
        elif args.command == 'analyze':
            print(f'正在分析工作流: {args.workflow}')
            
            # 读取工作流
            with open(args.workflow, 'r', encoding='utf-8') as f:
                workflow = json.load(f)
            
            # 分析节点类型
            node_types = {}
            total_nodes = 0
            
            for node_id, node in workflow.items():
                if isinstance(node, dict) and 'class_type' in node:
                    class_type = node['class_type']
                    node_types[class_type] = node_types.get(class_type, 0) + 1
                    total_nodes += 1
            
            print(f'✅ 分析完成!')
            print(f'总节点数: {total_nodes}')
            print('节点类型:')
            for class_type, count in sorted(node_types.items()):
                print(f'  {class_type}: {count}')
        
        elif args.command == 'placeholders':
            print(f'正在列出模板占位符: {args.template}')
            
            # 读取模板
            with open(args.template, 'r', encoding='utf-8') as f:
                template = json.load(f)
            
            # 获取占位符
            placeholders = processor.get_template_placeholders(template)
            
            print(f'✅ 找到 {len(placeholders)} 个占位符:')
            for placeholder in placeholders:
                print(f'  {placeholder}')
        
        else:
            print(f'❌ 未知命令: {args.command}')
            print('注意: 模板填充功能请使用各语言的主程序（如 ComfyUIGen.js）')
            parser.print_help()
    
    except FileNotFoundError as e:
        print(f'❌ 文件不存在: {e.filename}')
    except json.JSONDecodeError as e:
        print(f'❌ JSON格式错误: {e}')
    except Exception as e:
        print(f'❌ 错误: {e}')


if __name__ == '__main__':
    main()