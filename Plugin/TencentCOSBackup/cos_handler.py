# -*- coding=utf-8
import sys
import json
import os
import zipfile
import tempfile
import threading
import requests
import time
import logging
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from qcloud_cos import CosConfig
from qcloud_cos import CosS3Client
from qcloud_cos.cos_exception import CosClientError, CosServiceError
import traceback

# --- 配置和常量 ---
LOG_FILE = "cos_operations.log"
PLUGIN_NAME_FOR_CALLBACK = "ServerTencentCOSBackup"

# --- 日志记录 ---
def log_event(level, message, data=None):
    # 检查是否启用日志记录
    enable_logging = os.environ.get('ENABLE_LOGGING', 'true').lower() == 'true'
    
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] [{level.upper()}] {message}"
    if data:
        if isinstance(data, dict):
            log_data = {k: (v[:50] + '...' if isinstance(v, str) and len(v) > 100 else v) for k, v in data.items()}
        else:
            log_data = data
        try:
            log_entry += f" | Data: {json.dumps(log_data, ensure_ascii=False)}"
        except Exception:
            log_entry += f" | Data: [Unserializable Data]"
    
    # 输出到stderr以便调试
    print(log_entry, file=sys.stderr)
    
    # 只有启用日志记录时才写入文件
    if enable_logging:
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(log_entry + "\n")
        except Exception as e:
            print(f"Error writing to log file: {e}", file=sys.stderr)

# --- 结果输出 ---
def print_json_output(status, result=None, error=None, ai_message=None):
    output = {"status": status}
    if status == "success":
        if result is not None:
            output["result"] = result
        if ai_message:
            output["messageForAI"] = ai_message
    elif status == "error":
        if error is not None:
            output["error"] = error
    print(json.dumps(output, ensure_ascii=False))
    log_event("debug", "Output sent to stdout", output)

# --- 权限管理类 ---
class FolderPermission:
    def __init__(self, folder_name, upload, list_files, download, delete, copy_move):
        self.folder_name = folder_name
        self.upload = upload.lower() == "true"
        self.list_files = list_files.lower() == "true"
        self.download = download.lower() == "true"
        self.delete = delete.lower() == "true"
        self.copy_move = copy_move.lower() == "true"
    
    def get_permission_description(self):
        desc = f"文件夹 '{self.folder_name}' 权限：\n"
        desc += f"- 上传权限：{'允许' if self.upload else '禁止'}\n"
        desc += f"- 列出权限：{'允许' if self.list_files else '禁止'}\n"
        desc += f"- 下载权限：{'允许' if self.download else '禁止'}\n"
        desc += f"- 删除权限：{'允许' if self.delete else '禁止'}\n"
        desc += f"- 复制和移动权限：{'允许' if self.copy_move else '禁止'}"
        return desc

class PermissionManager:
    def __init__(self, folders_config_str):
        self.permissions = {}
        self._parse_folders_config(folders_config_str)
    
    def _parse_folders_config(self, config_str):
        """解析文件夹配置字符串"""
        try:
            folders = config_str.split(',')
            for folder in folders:
                parts = folder.strip().split(':')
                if len(parts) == 6:
                    folder_name, upload, list_files, download, delete, copy_move = parts
                    self.permissions[folder_name] = FolderPermission(
                        folder_name, upload, list_files, download, delete, copy_move
                    )
                    log_event("info", f"Parsed folder permission", {"folder": folder_name})
        except Exception as e:
            log_event("error", "Failed to parse folders config", {"error": str(e)})
    
    def get_permission(self, folder_name):
        """获取指定文件夹的权限"""
        return self.permissions.get(folder_name)
    
    def get_all_permissions_description(self):
        """获取所有文件夹权限的描述"""
        descriptions = []
        for folder_name, permission in self.permissions.items():
            descriptions.append(permission.get_permission_description())
        return "\n\n".join(descriptions)
    
    def check_permission(self, folder_name, action):
        """检查指定文件夹的特定操作权限"""
        permission = self.get_permission(folder_name)
        if not permission:
            return False, f"文件夹 '{folder_name}' 未在配置中定义"
        
        action_map = {
            'upload': permission.upload,
            'list': permission.list_files,
            'download': permission.download,
            'delete': permission.delete,
            'copy_move': permission.copy_move
        }
        
        if action not in action_map:
            return False, f"未知操作: {action}"
        
        if action_map[action]:
            return True, "权限允许"
        else:
            return False, f"文件夹 '{folder_name}' 不允许执行 '{action}' 操作"

# --- COS客户端管理 ---
class COSClientManager:
    def __init__(self):
        self.client = None
        self.bucket_name = None
        self.region = None
        self.agent_parent_dir = None
        self.permission_manager = None
        self.compress_threshold_mb = 100
        self.debug_mode = False
        self._initialize_client()
    
    def _initialize_client(self):
        """初始化COS客户端"""
        try:
            # 从环境变量读取配置
            secret_id = os.environ.get('TENCENTCLOUD_SECRET_ID')
            secret_key = os.environ.get('TENCENTCLOUD_SECRET_KEY')
            self.bucket_name = os.environ.get('COS_BUCKET_NAME')
            self.region = os.environ.get('COS_REGION')
            self.agent_parent_dir = os.environ.get('AGENT_PARENT_DIR', 'VCPAgentAI')
            folders_config = os.environ.get('AGENT_FOLDERS_CONFIG', '')
            self.compress_threshold_mb = int(os.environ.get('COMPRESS_THRESHOLD_MB', '100'))
            self.debug_mode = os.environ.get('DEBUG_MODE', 'false').lower() == 'true'
            
            if not secret_id or not secret_key:
                raise ValueError("TENCENTCLOUD_SECRET_ID 或 TENCENTCLOUD_SECRET_KEY 未配置")
            
            if not self.bucket_name or not self.region:
                raise ValueError("COS_BUCKET_NAME 或 COS_REGION 未配置")
            
            # 初始化COS配置
            config = CosConfig(
                Region=self.region,
                SecretId=secret_id,
                SecretKey=secret_key,
                Scheme='https'
            )
            
            # 创建COS客户端
            self.client = CosS3Client(config)
            
            # 初始化权限管理器
            self.permission_manager = PermissionManager(folders_config)
            
            log_event("info", "COS client initialized successfully", {
                "bucket": self.bucket_name,
                "region": self.region,
                "parent_dir": self.agent_parent_dir
            })
            
        except Exception as e:
            log_event("error", "Failed to initialize COS client", {"error": str(e)})
            raise
    
    def ensure_folder_structure(self):
        """确保COS中的文件夹结构存在"""
        try:
            log_event("info", "Checking and creating folder structure in COS")
            
            # 创建父目录
            parent_key = f"{self.agent_parent_dir}/"
            self.client.put_object(
                Bucket=self.bucket_name,
                Key=parent_key,
                Body=b'',
                ContentType='application/x-directory'
            )
            log_event("info", f"Created parent directory: {parent_key}")
            
            # 创建子目录
            for folder_name in self.permission_manager.permissions.keys():
                folder_key = f"{self.agent_parent_dir}/{folder_name}/"
                self.client.put_object(
                    Bucket=self.bucket_name,
                    Key=folder_key,
                    Body=b'',
                    ContentType='application/x-directory'
                )
                log_event("info", f"Created subdirectory: {folder_key}")
            
            log_event("success", "Folder structure created/verified successfully")
            return True
            
        except Exception as e:
            log_event("error", "Failed to create folder structure", {"error": str(e)})
            return False

# --- 文件压缩工具 ---
def compress_to_zip(file_path_or_dir, output_zip_path):
    """将文件或目录压缩为zip"""
    try:
        with zipfile.ZipFile(output_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            path_obj = Path(file_path_or_dir)
            
            if path_obj.is_file():
                # 压缩单个文件
                zipf.write(file_path_or_dir, path_obj.name)
            elif path_obj.is_dir():
                # 压缩目录
                for file_path in path_obj.rglob('*'):
                    if file_path.is_file():
                        arcname = file_path.relative_to(path_obj.parent)
                        zipf.write(file_path, arcname)
            else:
                raise ValueError(f"路径不存在: {file_path_or_dir}")
        
        log_event("info", f"Compressed to zip: {output_zip_path}")
        return True
        
    except Exception as e:
        log_event("error", f"Failed to compress to zip", {"error": str(e)})
        return False

def get_file_size_mb(file_path):
    """获取文件大小（MB）"""
    try:
        size_bytes = os.path.getsize(file_path)
        return size_bytes / (1024 * 1024)
    except Exception:
        return 0

# --- 文件操作功能 ---
class FileOperations:
    def __init__(self, cos_manager):
        self.cos_manager = cos_manager
    
    def upload_file(self, local_path, cos_folder, remote_filename=None):
        """上传文件到COS"""
        try:
            # 检查权限
            allowed, message = self.cos_manager.permission_manager.check_permission(cos_folder, 'upload')
            if not allowed:
                return {"success": False, "error": message}
            
            # 检查本地文件是否存在
            if not os.path.exists(local_path):
                return {"success": False, "error": f"本地文件不存在: {local_path}"}
            
            # 确定远程文件名
            if not remote_filename:
                remote_filename = os.path.basename(local_path)
            
            # 构建COS键
            cos_key = f"{self.cos_manager.agent_parent_dir}/{cos_folder}/{remote_filename}"
            
            # 检查文件大小，决定是否压缩
            file_size_mb = get_file_size_mb(local_path)
            should_compress = file_size_mb > self.cos_manager.compress_threshold_mb or os.path.isdir(local_path)
            
            if should_compress:
                # 创建临时zip文件
                with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as temp_zip:
                    temp_zip_path = temp_zip.name
                
                if compress_to_zip(local_path, temp_zip_path):
                    # 上传压缩文件
                    cos_key = f"{self.cos_manager.agent_parent_dir}/{cos_folder}/{remote_filename}.zip"
                    response = self.cos_manager.client.upload_file(
                        Bucket=self.cos_manager.bucket_name,
                        Key=cos_key,
                        LocalFilePath=temp_zip_path,
                        EnableMD5=True
                    )
                    # 清理临时文件
                    os.unlink(temp_zip_path)
                    
                    log_event("info", f"File uploaded and compressed", {
                        "local_path": local_path,
                        "cos_key": cos_key,
                        "original_size_mb": file_size_mb
                    })
                    
                    return {
                        "success": True,
                        "cos_key": cos_key,
                        "original_size_mb": file_size_mb,
                        "compressed": True,
                        "message": f"文件已压缩并上传到: {cos_key}"
                    }
                else:
                    # 压缩失败，尝试直接上传
                    os.unlink(temp_zip_path)
            
            # 直接上传文件
            response = self.cos_manager.client.upload_file(
                Bucket=self.cos_manager.bucket_name,
                Key=cos_key,
                LocalFilePath=local_path,
                EnableMD5=True
            )
            
            log_event("info", f"File uploaded successfully", {
                "local_path": local_path,
                "cos_key": cos_key,
                "size_mb": file_size_mb
            })
            
            return {
                "success": True,
                "cos_key": cos_key,
                "size_mb": file_size_mb,
                "compressed": False,
                "message": f"文件已上传到: {cos_key}"
            }
            
        except CosClientError as e:
            log_event("error", "COS client error during upload", {"error": str(e)})
            return {"success": False, "error": f"COS客户端错误: {e}"}
        except CosServiceError as e:
            log_event("error", "COS service error during upload", {"error": str(e)})
            return {"success": False, "error": f"COS服务错误: {e}"}
        except Exception as e:
            log_event("error", "Unexpected error during upload", {"error": str(e)})
            return {"success": False, "error": f"上传失败: {e}"}
    
    def download_file(self, cos_key, local_path=None):
        """从COS下载文件"""
        try:
            # 解析COS键获取文件夹信息
            key_parts = cos_key.split('/')
            if len(key_parts) < 3 or key_parts[0] != self.cos_manager.agent_parent_dir:
                return {"success": False, "error": f"无效的COS键格式: {cos_key}"}
            
            cos_folder = key_parts[1]
            
            # 检查权限
            allowed, message = self.cos_manager.permission_manager.check_permission(cos_folder, 'download')
            if not allowed:
                return {"success": False, "error": message}
            
            # 确定本地保存路径
            if not local_path:
                # 使用下载目录
                download_dir = os.path.join(os.path.dirname(__file__), 'download')
                os.makedirs(download_dir, exist_ok=True)
                filename = key_parts[-1]
                local_path = os.path.join(download_dir, filename)
            
            # 确保本地目录存在
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            
            # 下载文件
            response = self.cos_manager.client.download_file(
                Bucket=self.cos_manager.bucket_name,
                Key=cos_key,
                DestFilePath=local_path
            )
            
            file_size_mb = get_file_size_mb(local_path)
            
            log_event("info", f"File downloaded successfully", {
                "cos_key": cos_key,
                "local_path": local_path,
                "size_mb": file_size_mb
            })
            
            return {
                "success": True,
                "cos_key": cos_key,
                "local_path": local_path,
                "size_mb": file_size_mb,
                "message": f"文件已下载到: {local_path}"
            }
            
        except CosClientError as e:
            log_event("error", "COS client error during download", {"error": str(e)})
            return {"success": False, "error": f"COS客户端错误: {e}"}
        except CosServiceError as e:
            log_event("error", "COS service error during download", {"error": str(e)})
            return {"success": False, "error": f"COS服务错误: {e}"}
        except Exception as e:
            log_event("error", "Unexpected error during download", {"error": str(e)})
            return {"success": False, "error": f"下载失败: {e}"}
    
    def copy_file(self, source_cos_key, target_cos_folder, target_filename=None):
        """在COS中复制文件"""
        try:
            # 解析源COS键获取文件夹信息
            source_parts = source_cos_key.split('/')
            if len(source_parts) < 3 or source_parts[0] != self.cos_manager.agent_parent_dir:
                return {"success": False, "error": f"无效的源COS键格式: {source_cos_key}"}
            
            source_folder = source_parts[1]
            
            # 检查源文件夹的复制移动权限
            allowed, message = self.cos_manager.permission_manager.check_permission(source_folder, 'copy_move')
            if not allowed:
                return {"success": False, "error": message}
            
            # 检查目标文件夹的复制移动权限
            allowed, message = self.cos_manager.permission_manager.check_permission(target_cos_folder, 'copy_move')
            if not allowed:
                return {"success": False, "error": message}
            
            # 确定目标文件名
            if not target_filename:
                target_filename = source_parts[-1]
            
            # 构建目标COS键
            target_cos_key = f"{self.cos_manager.agent_parent_dir}/{target_cos_folder}/{target_filename}"
            
            # 执行复制操作
            response = self.cos_manager.client.copy(
                Bucket=self.cos_manager.bucket_name,
                Key=target_cos_key,
                CopySource={
                    'Bucket': self.cos_manager.bucket_name,
                    'Key': source_cos_key,
                    'Region': self.cos_manager.region
                }
            )
            
            log_event("info", f"File copied successfully", {
                "source_cos_key": source_cos_key,
                "target_cos_key": target_cos_key
            })
            
            return {
                "success": True,
                "source_cos_key": source_cos_key,
                "target_cos_key": target_cos_key,
                "message": f"文件已从 {source_cos_key} 复制到 {target_cos_key}"
            }
            
        except CosClientError as e:
            log_event("error", "COS client error during copy", {"error": str(e)})
            return {"success": False, "error": f"COS客户端错误: {e}"}
        except CosServiceError as e:
            log_event("error", "COS service error during copy", {"error": str(e)})
            return {"success": False, "error": f"COS服务错误: {e}"}
        except Exception as e:
            log_event("error", "Unexpected error during copy", {"error": str(e)})
            return {"success": False, "error": f"复制失败: {e}"}
    
    def move_file(self, source_cos_key, target_cos_folder, target_filename=None):
        """在COS中移动文件"""
        try:
            # 先复制文件
            copy_result = self.copy_file(source_cos_key, target_cos_folder, target_filename)
            if not copy_result["success"]:
                return copy_result
            
            # 复制成功后删除源文件
            delete_result = self.delete_file(source_cos_key, skip_permission_check=True)
            if not delete_result["success"]:
                # 如果删除失败，记录警告但不返回错误（因为复制已成功）
                log_event("warning", f"Source file deletion failed after copy", {
                    "source_cos_key": source_cos_key,
                    "error": delete_result["error"]
                })
            
            log_event("info", f"File moved successfully", {
                "source_cos_key": source_cos_key,
                "target_cos_key": copy_result["target_cos_key"]
            })
            
            return {
                "success": True,
                "source_cos_key": source_cos_key,
                "target_cos_key": copy_result["target_cos_key"],
                "message": f"文件已从 {source_cos_key} 移动到 {copy_result['target_cos_key']}"
            }
            
        except Exception as e:
            log_event("error", "Unexpected error during move", {"error": str(e)})
            return {"success": False, "error": f"移动失败: {e}"}
    
    def delete_file(self, cos_key, skip_permission_check=False):
        """删除COS中的文件"""
        try:
            # 解析COS键获取文件夹信息
            key_parts = cos_key.split('/')
            if len(key_parts) < 3 or key_parts[0] != self.cos_manager.agent_parent_dir:
                return {"success": False, "error": f"无效的COS键格式: {cos_key}"}
            
            cos_folder = key_parts[1]
            
            # 检查权限（除非跳过）
            if not skip_permission_check:
                allowed, message = self.cos_manager.permission_manager.check_permission(cos_folder, 'delete')
                if not allowed:
                    return {"success": False, "error": message}
            
            # 检查是否是目录（不能删除目录）
            if cos_key.endswith('/'):
                return {"success": False, "error": "不能删除目录，只能删除文件"}
            
            # 执行删除操作
            response = self.cos_manager.client.delete_object(
                Bucket=self.cos_manager.bucket_name,
                Key=cos_key
            )
            
            log_event("info", f"File deleted successfully", {
                "cos_key": cos_key
            })
            
            return {
                "success": True,
                "cos_key": cos_key,
                "message": f"文件已删除: {cos_key}"
            }
            
        except CosClientError as e:
            log_event("error", "COS client error during delete", {"error": str(e)})
            return {"success": False, "error": f"COS客户端错误: {e}"}
        except CosServiceError as e:
            log_event("error", "COS service error during delete", {"error": str(e)})
            return {"success": False, "error": f"COS服务错误: {e}"}
        except Exception as e:
            log_event("error", "Unexpected error during delete", {"error": str(e)})
            return {"success": False, "error": f"删除失败: {e}"}
    
    def list_files(self, cos_folder=None):
        """列出COS中的文件"""
        try:
            # 如果没有指定文件夹，列出所有文件夹
            if cos_folder is None:
                result = {}
                for folder_name in self.cos_manager.permission_manager.permissions.keys():
                    folder_result = self._list_folder_files(folder_name)
                    if folder_result["success"]:
                        result[folder_name] = folder_result["files"]
                    else:
                        result[folder_name] = f"错误: {folder_result['error']}"
                
                return {
                    "success": True,
                    "folders": result,
                    "message": "已列出所有文件夹的文件"
                }
            else:
                # 列出指定文件夹
                allowed, message = self.cos_manager.permission_manager.check_permission(cos_folder, 'list')
                if not allowed:
                    return {"success": False, "error": message}
                
                folder_result = self._list_folder_files(cos_folder)
                return folder_result
                
        except Exception as e:
            log_event("error", "Unexpected error during list", {"error": str(e)})
            return {"success": False, "error": f"列出失败: {e}"}
    
    def _list_folder_files(self, cos_folder):
        """列出指定文件夹的文件"""
        try:
            prefix = f"{self.cos_manager.agent_parent_dir}/{cos_folder}/"
            
            files = []
            marker = ""
            
            while True:
                response = self.cos_manager.client.list_objects(
                    Bucket=self.cos_manager.bucket_name,
                    Prefix=prefix,
                    Marker=marker,
                    MaxKeys=1000
                )
                
                if 'Contents' in response:
                    for content in response['Contents']:
                        # 跳过目录本身
                        key = content['Key']
                        if key != prefix:
                            # 获取相对路径
                            relative_path = key[len(prefix):]
                            files.append({
                                "key": key,
                                "name": relative_path,
                                "size": content.get('Size', 0),
                                "last_modified": content.get('LastModified', ''),
                                "etag": content.get('ETag', '')
                            })
                
                if response.get('IsTruncated') == 'false':
                    break
                
                marker = response.get("NextMarker", "")
            
            log_event("info", f"Listed files in folder", {
                "cos_folder": cos_folder,
                "file_count": len(files)
            })
            
            return {
                "success": True,
                "files": files,
                "message": f"文件夹 '{cos_folder}' 包含 {len(files)} 个文件"
            }
            
        except CosClientError as e:
            log_event("error", "COS client error during list", {"error": str(e)})
            return {"success": False, "error": f"COS客户端错误: {e}"}
        except CosServiceError as e:
            log_event("error", "COS service error during list", {"error": str(e)})
            return {"success": False, "error": f"COS服务错误: {e}"}
        except Exception as e:
            log_event("error", "Unexpected error during list", {"error": str(e)})
            return {"success": False, "error": f"列出失败: {e}"}

# --- 病毒检测功能 ---
class VirusDetection:
    def __init__(self, cos_manager):
        self.cos_manager = cos_manager
        self.callback_base_url = os.environ.get('CALLBACK_BASE_URL', 'http://localhost:6005/plugin-callback')
    
    def submit_virus_detection(self, key=None, url=None):
        """提交病毒检测任务"""
        try:
            # 验证参数
            if not key and not url:
                return {"success": False, "error": "必须提供key或url参数之一"}
            
            if key and url:
                return {"success": False, "error": "key和url参数只能提供其中一个"}
            
            # 构建请求参数
            params = {
                'Bucket': self.cos_manager.bucket_name,
                'Callback': self.callback_base_url
            }
            
            if key:
                # 验证key格式
                key_parts = key.split('/')
                if len(key_parts) < 3 or key_parts[0] != self.cos_manager.agent_parent_dir:
                    return {"success": False, "error": f"无效的COS键格式: {key}"}
                
                # 病毒检测无需权限检查
                params['Key'] = key
            else:
                params['Url'] = url
            
            # 调用腾讯云COS病毒检测API
            response = self.cos_manager.client.ci_auditing_virus_submit(**params)
            
            log_event("info", f"Virus detection submitted", {
                "key": key,
                "url": url,
                "response": response
            })
            
            return {
                "success": True,
                "job_id": response.get('JobsDetail', {}).get('JobId', ''),
                "state": response.get('JobsDetail', {}).get('State', ''),
                "creation_time": response.get('JobsDetail', {}).get('CreationTime', ''),
                "message": "病毒检测任务已提交"
            }
            
        except CosClientError as e:
            log_event("error", "COS client error during virus detection submission", {"error": str(e)})
            return {"success": False, "error": f"COS客户端错误: {e}"}
        except CosServiceError as e:
            log_event("error", "COS service error during virus detection submission", {"error": str(e)})
            return {"success": False, "error": f"COS服务错误: {e}"}
        except Exception as e:
            log_event("error", "Unexpected error during virus detection submission", {"error": str(e)})
            return {"success": False, "error": f"提交病毒检测失败: {e}"}
    
    def query_virus_detection(self, job_id):
        """查询病毒检测结果"""
        try:
            if not job_id:
                return {"success": False, "error": "缺少必需参数: job_id"}
            
            # 调用腾讯云COS病毒检测查询API
            response = self.cos_manager.client.ci_auditing_virus_query(
                Bucket=self.cos_manager.bucket_name,
                JobID=job_id
            )
            
            log_event("info", f"Virus detection query", {
                "job_id": job_id,
                "response": response
            })
            
            jobs_detail = response.get('JobsDetail', {})
            
            return {
                "success": True,
                "job_id": jobs_detail.get('JobId', job_id),
                "state": jobs_detail.get('State', ''),
                "creation_time": jobs_detail.get('CreationTime', ''),
                "object": jobs_detail.get('Object', ''),
                "url": jobs_detail.get('Url', ''),
                "suggestion": jobs_detail.get('Suggestion', ''),
                "detect_detail": jobs_detail.get('DetectDetail', []),
                "code": jobs_detail.get('Code', ''),
                "message": jobs_detail.get('Message', ''),
                "result_message": "病毒检测结果查询成功"
            }
            
        except CosClientError as e:
            log_event("error", "COS client error during virus detection query", {"error": str(e)})
            return {"success": False, "error": f"COS客户端错误: {e}"}
        except CosServiceError as e:
            log_event("error", "COS service error during virus detection query", {"error": str(e)})
            return {"success": False, "error": f"COS服务错误: {e}"}
        except Exception as e:
            log_event("error", "Unexpected error during virus detection query", {"error": str(e)})
            return {"success": False, "error": f"查询病毒检测结果失败: {e}"}

# --- 主逻辑 ---
def main():
    # 加载环境变量
    dotenv_path = os.path.join(os.path.dirname(__file__), 'config.env')
    load_dotenv(dotenv_path=dotenv_path)
    
    try:
        # 初始化COS客户端管理器
        cos_manager = COSClientManager()
        
        # 确保文件夹结构存在
        if not cos_manager.ensure_folder_structure():
            print_json_output("error", error="初始化COS文件夹结构失败")
            sys.exit(1)
        
        # 初始化文件操作
        file_ops = FileOperations(cos_manager)
        
        # 初始化病毒检测
        virus_detection = VirusDetection(cos_manager)
        
        # 读取输入
        try:
            input_str = sys.stdin.read()
            log_event("debug", "Received input from stdin", {"input_length": len(input_str)})
            input_data = json.loads(input_str)
        except json.JSONDecodeError:
            log_event("error", "Failed to decode JSON input")
            print_json_output("error", error="无效的JSON输入")
            sys.exit(1)
        
        command = input_data.get("command")
        
        if command == "get_permissions":
            # 返回权限描述
            description = cos_manager.permission_manager.get_all_permissions_description()
            result = {
                "bucket_name": cos_manager.bucket_name,
                "region": cos_manager.region,
                "parent_directory": cos_manager.agent_parent_dir,
                "permissions": description,
                "compress_threshold_mb": cos_manager.compress_threshold_mb
            }
            print_json_output("success", result=result)
        
        elif command == "upload_file":
            local_path = input_data.get("local_path")
            cos_folder = input_data.get("cos_folder")
            remote_filename = input_data.get("remote_filename")
            
            if not local_path or not cos_folder:
                print_json_output("error", error="缺少必需参数: local_path, cos_folder")
                sys.exit(1)
            
            result = file_ops.upload_file(local_path, cos_folder, remote_filename)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        elif command == "download_file":
            cos_key = input_data.get("cos_key")
            local_path = input_data.get("local_path")
            
            if not cos_key:
                print_json_output("error", error="缺少必需参数: cos_key")
                sys.exit(1)
            
            result = file_ops.download_file(cos_key, local_path)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        elif command == "copy_file":
            source_cos_key = input_data.get("source_cos_key")
            target_cos_folder = input_data.get("target_cos_folder")
            target_filename = input_data.get("target_filename")
            
            if not source_cos_key or not target_cos_folder:
                print_json_output("error", error="缺少必需参数: source_cos_key, target_cos_folder")
                sys.exit(1)
            
            result = file_ops.copy_file(source_cos_key, target_cos_folder, target_filename)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        elif command == "move_file":
            source_cos_key = input_data.get("source_cos_key")
            target_cos_folder = input_data.get("target_cos_folder")
            target_filename = input_data.get("target_filename")
            
            if not source_cos_key or not target_cos_folder:
                print_json_output("error", error="缺少必需参数: source_cos_key, target_cos_folder")
                sys.exit(1)
            
            result = file_ops.move_file(source_cos_key, target_cos_folder, target_filename)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        elif command == "delete_file":
            cos_key = input_data.get("cos_key")
            
            if not cos_key:
                print_json_output("error", error="缺少必需参数: cos_key")
                sys.exit(1)
            
            result = file_ops.delete_file(cos_key)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        elif command == "list_files":
            cos_folder = input_data.get("cos_folder")
            
            result = file_ops.list_files(cos_folder)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        elif command == "submit_virus_detection_by_key":
            key = input_data.get("key")
            
            if not key:
                print_json_output("error", error="缺少必需参数: key")
                sys.exit(1)
            
            result = virus_detection.submit_virus_detection(key=key, url=None)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        elif command == "submit_virus_detection_by_url":
            url = input_data.get("url")
            
            if not url:
                print_json_output("error", error="缺少必需参数: url")
                sys.exit(1)
            
            result = virus_detection.submit_virus_detection(key=None, url=url)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        elif command == "query_virus_detection":
            job_id = input_data.get("job_id")
            
            if not job_id:
                print_json_output("error", error="缺少必需参数: job_id")
                sys.exit(1)
            
            result = virus_detection.query_virus_detection(job_id)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        else:
            # 其他命令的占位符实现
            print_json_output("error", error=f"命令 '{command}' 暂未实现")
            sys.exit(1)
    
    except Exception as e:
        log_event("error", "Unexpected error in main", {"error": str(e), "traceback": traceback.format_exc()})
        print_json_output("error", error=f"发生意外错误: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()