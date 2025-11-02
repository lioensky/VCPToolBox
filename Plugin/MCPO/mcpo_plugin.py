#!/usr/bin/env python3
"""
MCPO Plugin for VCP System
基于 mcpo 的 MCP 工具桥接插件

该插件实现了 VCP 系统与 MCP (Model Context Protocol) 工具的桥接，
通过 mcpo 作为中间层，实现对 MCP 工具的自动发现、缓存和调用。
"""

import os
import sys
import json
import subprocess
import time
import signal
import logging
import threading
from typing import Dict, Any, Optional, List
import requests
import psutil
from pathlib import Path

class MCPOPlugin:
    def __init__(self):
        # 设置日志
        logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
        self.logger = logging.getLogger(__name__)
        
        self.config = self._load_config()
        self.mcpo_process = None
        # 使用绝对路径的PID文件
        self.mcpo_pid_file = Path(os.path.abspath("mcpo.pid"))
        self.base_url = f"http://localhost:{self.config['MCPO_PORT']}"
        self.api_key = self.config['MCPO_API_KEY']
        self.headers = {
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json'
        }
        
    def _load_config(self) -> Dict[str, Any]:
        """加载配置"""
        # 加载插件特定的config.env文件
        from dotenv import load_dotenv
        plugin_env_path = os.path.join(os.path.dirname(__file__), 'config.env')
        if os.path.exists(plugin_env_path):
            load_dotenv(plugin_env_path, override=True)
        
        # 获取自定义配置文件名称（如果指定）
        custom_config_name = os.getenv('MCPO_CONFIG_NAME', '')
        env_config_path = os.getenv('MCP_CONFIG_PATH', './mcp-config.json')
        
        # 调试信息
        if hasattr(self, 'logger'):
            self.logger.info(f"Environment MCP_CONFIG_PATH: {env_config_path}")
            self.logger.info(f"Environment MCPO_CONFIG_NAME: {custom_config_name}")
            self.logger.info(f"Environment DEFAULT_TIMEZONE: {os.getenv('DEFAULT_TIMEZONE', 'UTC')}") # 诊断日志
        
        # 根据是否指定了自定义配置文件名称来决定配置文件路径
        if custom_config_name:
            # 如果指定了自定义配置文件名称，在插件目录下查找
            plugin_dir = os.path.dirname(os.path.abspath(__file__))
            if not custom_config_name.endswith('-config.json'):
                custom_config_name = f"{custom_config_name}-config.json"
            default_config_path = os.path.join(plugin_dir, custom_config_name)
        else:
            # 如果没有指定，使用环境变量或默认路径
            # 如果是相对路径，转换为绝对路径
            if env_config_path.startswith('./'):
                project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../'))
                default_config_path = os.path.join(project_root, env_config_path[2:])
            elif env_config_path.startswith('/'):
                # 已经是绝对路径
                default_config_path = env_config_path
            else:
                # 相对路径，相对于VCP根目录
                project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../'))
                default_config_path = os.path.join(project_root, env_config_path)
        
        config = {
            'MCPO_PORT': int(os.getenv('MCPO_PORT', '9000')),
            'MCPO_API_KEY': os.getenv('MCPO_API_KEY', 'vcp-mcpo-secret'),
            'MCPO_AUTO_START': os.getenv('MCPO_AUTO_START', 'true').lower() == 'true',
            'PYTHON_EXECUTABLE': os.getenv('PYTHON_EXECUTABLE', 'python'),
            'MCP_CONFIG_PATH': default_config_path,  # 使用处理后的路径
            'MCPO_HOT_RELOAD': os.getenv('MCPO_HOT_RELOAD', 'true').lower() == 'true',
            'MCPO_CONFIG_NAME': custom_config_name,  # 记录自定义配置名称
            'DEFAULT_TIMEZONE': os.getenv('DEFAULT_TIMEZONE', 'Asia/Shanghai') # 新增时区配置
        }
        
        self.logger.info(f"Loaded config: Port={config['MCPO_PORT']}, ConfigPath={config['MCP_CONFIG_PATH']}, HotReload={config['MCPO_HOT_RELOAD']}, CustomConfigName={config['MCPO_CONFIG_NAME']}")
        
        return config
    
    def _find_mcpo_process(self) -> Optional[int]:
        """查找 MCPO 进程 PID"""
        try:
            # 首先尝试从 PID 文件读取
            if self.mcpo_pid_file.exists():
                try:
                    with open(self.mcpo_pid_file, 'r') as f:
                        pid = int(f.read().strip())
                    
                    # 验证进程是否还在运行
                    try:
                        process = psutil.Process(pid)
                        if process.is_running() and 'mcpo' in ' '.join(process.cmdline()).lower():
                            return pid
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                except (ValueError, FileNotFoundError):
                    pass
            
            # 如果 PID 文件不可靠，通过端口查找进程
            for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
                try:
                    cmdline = proc.info.get('cmdline', [])
                    if not cmdline:
                        continue
                    
                    # 检查是否是 mcpo 进程
                    cmdline_str = ' '.join(cmdline).lower()
                    if 'mcpo' in cmdline_str and str(self.config['MCPO_PORT']) in cmdline_str:
                        # 双重验证：检查端口绑定
                        try:
                            process = psutil.Process(proc.pid)
                            connections = process.connections(kind='inet')
                            for conn in connections:
                                if (conn.laddr.port == self.config['MCPO_PORT'] and 
                                    conn.status == 'LISTEN'):
                                    self.logger.info(f"Found MCPO process by port: PID {proc.pid}")
                                    return proc.pid
                        except (psutil.AccessDenied, psutil.NoSuchProcess):
                            # 如果无法访问连接信息，只要命令行匹配就返回
                            self.logger.info(f"Found MCPO process by cmdline: PID {proc.pid}")
                            return proc.pid
                            
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    continue
                    
            return None
            
        except Exception as e:
            self.logger.warning(f"Error finding MCPO process: {e}")
            return None
    
    def _is_server_running(self) -> bool:
        """检查 MCPO 服务器是否运行"""
        try:
            response = requests.get(f"{self.base_url}/docs", timeout=5)
            return response.status_code == 200
        except:
            return False
    
    def _start_mcpo_server(self) -> bool:
        """启动 MCPO 服务器"""
        try:
            # 检查配置文件是否存在
            config_path = self.config['MCP_CONFIG_PATH']
            if not os.path.exists(config_path):
                # 创建示例配置文件
                self._create_example_config()
            
            # 构建启动命令
            cmd = [
                'mcpo',  # 直接使用 mcpo 命令
                '--config', config_path,
                '--port', str(self.config['MCPO_PORT']),
                '--api-key', self.config['MCPO_API_KEY']
            ]
            
            if self.config['MCPO_HOT_RELOAD']:
                cmd.append('--hot-reload')
            
            self.logger.info(f"Starting MCPO server with command: {' '.join(cmd)}")
            
            # 启动进程（使用更好的进程管理）
            # 设置工作目录为项目根目录，确保配置文件路径正确
            project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../'))
            self.mcpo_process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,  # 避免管道阻塞
                stderr=subprocess.DEVNULL,
                start_new_session=True,  # 创建新的进程组
                cwd=project_root,  # 从项目根目录启动
                env=os.environ.copy()
            )
            
            # 保存 PID
            with open(self.mcpo_pid_file, 'w') as f:
                f.write(str(self.mcpo_process.pid))
            
            self.logger.info(f"MCPO server started with PID: {self.mcpo_process.pid}")
            
            # 等待服务器启动
            for i in range(60):  # 等待最多 60 秒（增加超时时间）
                if self._is_server_running():
                    self.logger.info("MCPO server started successfully")
                    return True
                time.sleep(1)
            
            self.logger.error("MCPO server failed to start within timeout (60 seconds)")
            return False
            
        except Exception as e:
            self.logger.error(f"Failed to start MCPO server: {e}")
            return False
    
    def _stop_mcpo_server(self) -> bool:
        """停止 MCPO 服务器"""
        try:
            stopped = False
            
            # 使用增强的进程查找机制
            pid = self._find_mcpo_process()
            
            if pid:
                self.logger.info(f"Attempting to stop MCPO server with PID: {pid}")
                
                try:
                    process = psutil.Process(pid)
                    
                    # 检查进程是否存在
                    if process.is_running():
                        # 先尝试优雅关闭
                        process.terminate()
                        
                        # 等待进程终止
                        try:
                            process.wait(timeout=10)
                            stopped = True
                            self.logger.info("MCPO server terminated gracefully")
                        except psutil.TimeoutExpired:
                            # 强制终止
                            self.logger.warning("Graceful termination timeout, forcing kill")
                            process.kill()
                            try:
                                process.wait(timeout=5)
                                stopped = True
                                self.logger.info("MCPO server force killed")
                            except psutil.TimeoutExpired:
                                self.logger.error("Failed to kill MCPO process")
                    else:
                        self.logger.info("MCPO process not running")
                        stopped = True
                        
                except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
                    self.logger.info(f"MCPO process not found or access denied: {e}")
                    stopped = True
                except Exception as pe:
                    self.logger.error(f"Error stopping process {pid}: {pe}")
            else:
                self.logger.info("No MCPO process found")
                stopped = True
            
            # 清理 PID 文件
            if self.mcpo_pid_file.exists():
                self.mcpo_pid_file.unlink(missing_ok=True)
            
            # 终止 subprocess 对象
            if self.mcpo_process and self.mcpo_process.poll() is None:
                try:
                    self.mcpo_process.terminate()
                    self.mcpo_process.wait(timeout=5)
                    stopped = True
                except subprocess.TimeoutExpired:
                    try:
                        self.mcpo_process.kill()
                        self.mcpo_process.wait()
                        stopped = True
                    except:
                        pass
            
            # 验证服务器是否真的停止
            if stopped:
                for _ in range(10):  # 等待最多 10 秒
                    if not self._is_server_running():
                        self.logger.info("MCPO server stopped successfully")
                        return True
                    time.sleep(1)
            
            self.logger.warning("MCPO server may not have stopped completely")
            return stopped
            
        except Exception as e:
            self.logger.error(f"Failed to stop MCPO server: {e}")
            return False
    
    def _create_example_config(self):
        """创建示例 MCP 配置文件"""
        example_config = {
            "mcpServers": {
                "time": {
                    "command": "uvx",
                    "args": ["mcp-server-time", f"--local-timezone={self.config['DEFAULT_TIMEZONE']}"]
                }
            }
        }
        
        config_path = self.config['MCP_CONFIG_PATH']
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(example_config, f, indent=2, ensure_ascii=False)
        
        self.logger.info(f"Created example MCP config at {config_path}")
    
    def _make_request(self, method: str, endpoint: str, **kwargs) -> Dict[str, Any]:
        """发送 HTTP 请求到 MCPO 服务器"""
        url = f"{self.base_url}{endpoint}"
        
        try:
            response = requests.request(
                method, url, 
                headers=self.headers,
                timeout=30,
                **kwargs
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            raise Exception(f"Request failed: {e}")
    
    def list_tools(self) -> Dict[str, Any]:
        """列出所有可用工具"""
        try:
            # 获取主 OpenAPI 规范
            main_spec = self._make_request('GET', '/openapi.json')
            
            tools = {}
            
            # 从描述中提取可用的服务器
            description = main_spec.get('info', {}).get('description', '')
            servers = []
            
            # 解析描述中的服务器链接
            import re
            server_pattern = r'\[([^\]]+)\]\(/([^/\)]+)/docs\)'
            matches = re.findall(server_pattern, description)
            
            for server_name, server_path in matches:
                servers.append(server_path)
            
            self.logger.info(f"Found servers: {servers}")
            
            # 为每个服务器获取工具
            for server in servers:
                try:
                    server_spec = self._make_request('GET', f'/{server}/openapi.json')
                    server_paths = server_spec.get('paths', {})
                    
                    for path, methods in server_paths.items():
                        if path.startswith('/') and 'post' in methods:
                            tool_name = path.strip('/')
                            if tool_name:
                                # 使用服务器前缀来区分工具
                                full_tool_name = f"{server}_{tool_name}"
                                post_info = methods['post']
                                tools[full_tool_name] = {
                                    'name': full_tool_name,
                                    'original_name': tool_name,
                                    'server': server,
                                    'description': post_info.get('description', ''),
                                    'summary': post_info.get('summary', ''),
                                    'parameters': self._extract_parameters(post_info),
                                    'endpoint': f'/{server}{path}'
                                }
                except Exception as server_error:
                    self.logger.warning(f"Failed to get tools from server {server}: {server_error}")
                    continue
            
            return {
                'success': True,
                'tools': tools,
                'count': len(tools)
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
    
    def _extract_parameters(self, post_info: Dict[str, Any]) -> Dict[str, Any]:
        """从 OpenAPI 规范中提取参数信息"""
        parameters = {}
        
        request_body = post_info.get('requestBody', {})
        if request_body:
            content = request_body.get('content', {})
            json_content = content.get('application/json', {})
            schema = json_content.get('schema', {})
            
            # 处理 $ref 引用
            if '$ref' in schema:
                ref_path = schema['$ref']
                # 解析 $ref 引用获取实际的 schema 定义
                resolved_schema = self._resolve_schema_ref(ref_path, post_info)
                if resolved_schema:
                    properties = resolved_schema.get('properties', {})
                    required = resolved_schema.get('required', [])
                    
                    for param_name, param_info in properties.items():
                        parameters[param_name] = {
                            'type': param_info.get('type', 'string'),
                            'description': param_info.get('description', ''),
                            'required': param_name in required,
                            'default': param_info.get('default'),
                            'title': param_info.get('title', ''),
                            'example': param_info.get('example')
                        }
                else:
                    # 如果无法解析引用，回退到简单信息
                    parameters['$ref'] = ref_path
                    parameters['note'] = 'Parameters defined by schema reference (unable to resolve)'
            else:
                # 直接定义的参数
                properties = schema.get('properties', {})
                required = schema.get('required', [])
                
                for param_name, param_info in properties.items():
                    parameters[param_name] = {
                        'type': param_info.get('type', 'string'),
                        'description': param_info.get('description', ''),
                        'required': param_name in required,
                        'default': param_info.get('default'),
                        'title': param_info.get('title', ''),
                        'example': param_info.get('example')
                    }
        
        return parameters
    
    def _resolve_schema_ref(self, ref_path: str, post_info: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """解析 OpenAPI schema 引用"""
        try:
            # 提取引用路径中的 schema 名称
            # 格式通常是 "#/components/schemas/schema_name"
            if ref_path.startswith('#/components/schemas/'):
                schema_name = ref_path.split('/')[-1]
                
                # 需要从完整的 server spec 中获取 components
                # 从 endpoint 信息推断服务器名称
                server_name = None
                
                # 从当前 post_info 的上下文中尝试获取服务器信息
                # 这里我们需要重新请求完整的 openapi.json 来获取 components
                
                # 尝试从多个可能的服务器获取 schema
                for server in ['time', 'context7', 'memory', 'filesystem', 'brave_search', 'web_search', 'github']:
                    try:
                        server_spec = self._make_request('GET', f'/{server}/openapi.json')
                        if server_spec and 'components' in server_spec:
                            schemas = server_spec['components'].get('schemas', {})
                            if schema_name in schemas:
                                return schemas[schema_name]
                    except:
                        continue
                        
            return None
        except Exception as e:
            self.logger.warning(f"Failed to resolve schema reference {ref_path}: {e}")
            return None
    
    def call_tool(self, tool_name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """调用指定工具"""
        try:
            if not tool_name:
                return {
                    'success': False,
                    'error': 'Tool name is required'
                }
            
            # 准备请求数据
            data = arguments or {}
            
            # 判断是否是新格式的工具名称（server_toolname）
            if '_' in tool_name:
                # 新格式: server_toolname
                parts = tool_name.split('_', 1)
                if len(parts) == 2:
                    server, original_tool = parts
                    endpoint = f'/{server}/{original_tool}'
                else:
                    endpoint = f'/{tool_name}'
            else:
                # 旧格式或直接工具名
                endpoint = f'/{tool_name}'
            
            self.logger.info(f"Calling tool {tool_name} at endpoint {endpoint}")
            
            # 发送请求
            result = self._make_request('POST', endpoint, json=data)
            
            return {
                'success': True,
                'tool_name': tool_name,
                'endpoint': endpoint,
                'result': result
            }
            
        except Exception as e:
            return {
                'success': False,
                'tool_name': tool_name,
                'error': str(e)
            }
    
    def get_tool_info(self, tool_name: str) -> Dict[str, Any]:
        """获取工具详细信息"""
        try:
            tools = self.list_tools()
            if not tools['success']:
                return tools
            
            if tool_name in tools['tools']:
                return {
                    'success': True,
                    'tool_info': tools['tools'][tool_name]
                }
            else:
                return {
                    'success': False,
                    'error': f'Tool "{tool_name}" not found'
                }
                
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
    
    def manage_server(self, operation: str) -> Dict[str, Any]:
        """管理 MCPO 服务器"""
        try:
            if operation == 'start':
                # 先检查服务是否已经在运行（容错机制）
                if self._is_server_running():
                    # 服务已经运行，检查 PID 文件状态
                    pid = self._find_mcpo_process()
                    if pid:
                        self.logger.info(f"MCPO server is already running with PID: {pid}")
                        return {
                            'success': True,
                            'message': f'MCPO server is already running (PID: {pid})'
                        }
                    else:
                        self.logger.info("MCPO server is running but PID not found, service is healthy")
                        return {
                            'success': True,
                            'message': 'MCPO server is already running'
                        }
                else:
                    # 检查是否有残留的 PID 文件但服务未运行
                    if self.mcpo_pid_file.exists():
                        try:
                            with open(self.mcpo_pid_file, 'r') as f:
                                old_pid = int(f.read().strip())
                            
                            # 检查该 PID 是否仍然存在
                            try:
                                process = psutil.Process(old_pid)
                                if not process.is_running():
                                    self.logger.info(f"Cleaning up stale PID file for non-existent process {old_pid}")
                                    self.mcpo_pid_file.unlink(missing_ok=True)
                            except (psutil.NoSuchProcess, psutil.AccessDenied):
                                self.logger.info(f"Cleaning up stale PID file for non-existent process {old_pid}")
                                self.mcpo_pid_file.unlink(missing_ok=True)
                        except (ValueError, FileNotFoundError):
                            self.logger.info("Cleaning up invalid PID file")
                            self.mcpo_pid_file.unlink(missing_ok=True)
                    
                    # 现在尝试启动服务
                    success = self._start_mcpo_server()
                    return {
                        'success': success,
                        'message': 'MCPO server started' if success else 'Failed to start MCPO server'
                    }
            
            elif operation == 'stop':
                # 先检查服务是否正在运行（容错机制）
                if not self._is_server_running():
                    # 服务已经停止，清理 PID 文件并返回成功
                    if self.mcpo_pid_file.exists():
                        self.mcpo_pid_file.unlink(missing_ok=True)
                        self.logger.info("Cleaned up stale PID file")
                    return {
                        'success': True,
                        'message': 'MCPO server is already stopped'
                    }
                else:
                    success = self._stop_mcpo_server()
                    return {
                        'success': success,
                        'message': 'MCPO server stopped' if success else 'Failed to stop MCPO server'
                    }
            
            elif operation == 'restart':
                # 重启的容错机制：检查当前状态并采取合适的行动
                is_running = self._is_server_running()
                
                if is_running:
                    self.logger.info("Service is running, performing restart (stop + start)")
                    # 服务正在运行，执行完整的重启流程
                    stop_success = self._stop_mcpo_server()
                    if not stop_success:
                        self.logger.warning("Stop operation had issues, but proceeding with start")
                    time.sleep(2)  # 等待完全停止
                    
                    success = self._start_mcpo_server()
                    return {
                        'success': success,
                        'message': f'MCPO server restarted (was running)' if success else 'Failed to restart MCPO server (was running)'
                    }
                else:
                    self.logger.info("Service not running, restart becomes direct start")
                    # 服务未运行，重启等同于直接启动
                    # 清理可能存在的 PID 文件
                    if self.mcpo_pid_file.exists():
                        self.mcpo_pid_file.unlink(missing_ok=True)
                        self.logger.info("Cleaned up stale PID file before start")
                    
                    success = self._start_mcpo_server()
                    return {
                        'success': success,
                        'message': f'MCPO server started (was stopped)' if success else 'Failed to start MCPO server (was stopped)'
                    }
            
            elif operation == 'status':
                running = self._is_server_running()
                return {
                    'success': True,
                    'status': 'running' if running else 'stopped',
                    'url': self.base_url if running else None,
                    'config_file': self.config['MCP_CONFIG_PATH'],
                    'config_exists': os.path.exists(self.config['MCP_CONFIG_PATH']),
                    'hot_reload_enabled': self.config['MCPO_HOT_RELOAD'],
                    'custom_config_name': self.config.get('MCPO_CONFIG_NAME', '')
                }
            
            elif operation == 'reload_config':
                # 重新加载配置文件（利用mcpo的热重载功能）
                if not self._is_server_running():
                    return {
                        'success': False,
                        'error': 'MCPO server is not running. Please start the server first.'
                    }
                
                # 检查配置文件是否存在
                config_path = self.config['MCP_CONFIG_PATH']
                if not os.path.exists(config_path):
                    return {
                        'success': False,
                        'error': f'Config file not found: {config_path}'
                    }
                
                # 如果启用了热重载，mcpo会自动检测文件变化
                if self.config['MCPO_HOT_RELOAD']:
                    return {
                        'success': True,
                        'message': f'Hot reload is enabled. Configuration changes in {config_path} will be automatically detected by mcpo.',
                        'note': 'No manual reload needed when hot reload is enabled.'
                    }
                else:
                    # 如果没有启用热重载，建议重启服务
                    return {
                        'success': True,
                        'message': 'Hot reload is disabled. To apply configuration changes, please restart the server.',
                        'suggestion': 'Use restart operation or enable MCPO_HOT_RELOAD for automatic configuration reloading.'
                    }
            
            else:
                return {
                    'success': False,
                    'error': f'Unknown operation: {operation}'
                }
                
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
    
    def discover_tools(self) -> Dict[str, Any]:
        """重新发现工具"""
        try:
            # 重启服务器以重新加载配置
            restart_result = self.manage_server('restart')
            if not restart_result['success']:
                return restart_result
            
            # 获取工具列表
            time.sleep(2)  # 等待服务器完全启动
            tools_result = self.list_tools()
            
            return {
                'success': True,
                'message': 'Tools discovered successfully',
                'tools_count': tools_result.get('count', 0) if tools_result['success'] else 0
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
    
    def list_configs(self) -> Dict[str, Any]:
        """列出所有可用的配置文件"""
        try:
            configs = []
            
            # 检查VCP根目录下的mcp-config.json
            project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../'))
            root_config = os.path.join(project_root, 'mcp-config.json')
            if os.path.exists(root_config):
                configs.append({
                    'name': 'mcp-config.json (默认)',
                    'path': root_config,
                    'type': 'root_default',
                    'exists': True,
                    'current': self.config['MCP_CONFIG_PATH'] == root_config
                })
            
            # 检查插件目录下的所有 *-config.json 文件
            plugin_dir = os.path.dirname(os.path.abspath(__file__))
            try:
                # 检查插件目录本身
                for file in os.listdir(plugin_dir):
                    if file.endswith('-config.json'):
                        file_path = os.path.join(plugin_dir, file)
                        config_name = file.replace('-config.json', '')
                        
                        configs.append({
                            'name': f'{file} (插件目录)',
                            'path': file_path,
                            'type': 'plugin_custom',
                            'config_name': config_name,
                            'exists': True,
                            'current': self.config['MCP_CONFIG_PATH'] == file_path
                        })
                
                # 检查插件目录下的custom-mcp-config子目录
                custom_config_dir = os.path.join(plugin_dir, 'custom-mcp-config')
                if os.path.exists(custom_config_dir) and os.path.isdir(custom_config_dir):
                    for file in os.listdir(custom_config_dir):
                        if file.endswith('-config.json'):
                            file_path = os.path.join(custom_config_dir, file)
                            config_name = file.replace('-config.json', '')
                            
                            configs.append({
                                'name': f'{file} (custom-mcp-config)',
                                'path': file_path,
                                'type': 'plugin_custom_subdir',
                                'config_name': config_name,
                                'exists': True,
                                'current': self.config['MCP_CONFIG_PATH'] == file_path
                            })
            except Exception as e:
                self.logger.warning(f"Error listing plugin directory: {e}")
            
            return {
                'success': True,
                'configs': configs,
                'current_config': self.config['MCP_CONFIG_PATH'],
                'hot_reload_enabled': self.config['MCPO_HOT_RELOAD']
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }
    
    def health_check(self) -> Dict[str, Any]:
        """健康检查"""
        try:
            health = {
                'mcpo_server': {
                    'running': self._is_server_running(),
                    'url': self.base_url,
                    'config_file': self.config['MCP_CONFIG_PATH'],
                    'config_exists': os.path.exists(self.config['MCP_CONFIG_PATH'])
                }
            }
            
            # 如果服务器运行，获取更多信息
            if health['mcpo_server']['running']:
                try:
                    tools = self.list_tools()
                    health['tools'] = {
                        'available': tools['success'],
                        'count': tools.get('count', 0) if tools['success'] else 0
                    }
                except:
                    health['tools'] = {
                        'available': False,
                        'count': 0,
                        'error': 'Failed to fetch tools'
                    }
            
            return {
                'success': True,
                'health': health
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }

    def process_request(self, request_data: Dict[str, Any]) -> Dict[str, Any]:
        """处理 VCP 请求"""
        try:
            action = request_data.get('action', '').lower()
            
            if action == 'list_tools':
                return self.list_tools()
            
            elif action == 'call_tool':
                tool_name = request_data.get('tool_name_param', '')
                arguments_str = request_data.get('arguments', '{}')
                
                # 解析 JSON 参数
                try:
                    arguments = json.loads(arguments_str) if arguments_str else {}
                except json.JSONDecodeError:
                    return {
                        'success': False,
                        'error': f'Invalid JSON in arguments: {arguments_str}'
                    }
                
                return self.call_tool(tool_name, arguments)
            
            elif action == 'get_tool_info':
                tool_name = request_data.get('tool_name_param', '')
                return self.get_tool_info(tool_name)
            
            elif action == 'manage_server':
                operation = request_data.get('operation', '')
                return self.manage_server(operation)
            
            elif action == 'discover_tools':
                return self.discover_tools()
            
            elif action == 'health_check':
                return self.health_check()
            
            elif action == 'list_configs':
                return self.list_configs()
            
            else:
                return {
                    'success': False,
                    'error': f'Unknown action: {action}'
                }
                
        except Exception as e:
            return {
                'success': False,
                'error': f'Processing error: {str(e)}'
            }

def main():
    """主入口函数"""
    try:
        # 读取标准输入
        input_data = sys.stdin.read().strip()
        
        if not input_data:
            print(json.dumps({
                'status': 'error',
                'error': 'No input data provided'
            }))
            sys.exit(1)
        
        # 解析输入
        try:
            request_data = json.loads(input_data)
        except json.JSONDecodeError:
            print(json.dumps({
                'status': 'error',
                'error': f'Invalid JSON input: {input_data}'
            }))
            sys.exit(1)
        
        # 创建插件实例
        plugin = MCPOPlugin()
        
        # 检查操作类型，只在非 manage_server 操作时才自动启动
        action = request_data.get('action', '').lower()
        
        # 自动启动服务器（如果需要且不是管理操作）
        if (action != 'manage_server' and 
            plugin.config['MCPO_AUTO_START'] and 
            not plugin._is_server_running()):
            plugin._start_mcpo_server()
        
        # 处理请求
        result = plugin.process_request(request_data)
        
        # 构建响应
        if result.get('success', False):
            output = {
                'status': 'success',
                'result': result
            }
        else:
            output = {
                'status': 'error',
                'error': result.get('error', 'Unknown error'),
                'result': result
            }
        
        # 输出结果
        print(json.dumps(output, ensure_ascii=False, indent=2))
        
    except Exception as e:
        print(json.dumps({
            'status': 'error',
            'error': f'Plugin execution failed: {str(e)}'
        }))
        sys.exit(1)

if __name__ == "__main__":
    main()