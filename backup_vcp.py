import os
import zipfile
import datetime

def backup_user_data(backup_filename):
    """
    将指定文件类型从当前目录备份到zip文件，
    并保留目录结构。
    """
    # 定义要备份的文件扩展名
    file_extensions = ['.txt', '.md', '.env', '.json']

    # 获取当前目录
    source_dir = '.'

    print(f"开始备份到 {backup_filename}...")
    
    # 创建一个新的zip文件
    with zipfile.ZipFile(backup_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # 遍历目录
        for root, dirs, files in os.walk(source_dir):
            # 排除备份脚本本身和常见的非用户数据目录
            dirs[:] = [d for d in dirs if d not in ['.git', '__pycache__', 'node_modules']]
            
            for file in files:
                # 检查文件扩展名
                if any(file.endswith(ext) for ext in file_extensions):
                    # 排除备份文件自身
                    if os.path.join(root, file) == os.path.join(source_dir, backup_filename):
                        continue
                    
                    file_path = os.path.join(root, file)
                    print(f"正在添加: {file_path}")
                    # 写入文件到zip，使用相对路径以保留目录结构
                    zipf.write(file_path, os.path.relpath(file_path, source_dir))

    print(f"\n备份成功完成: {backup_filename}")

if __name__ == "__main__":
    # 生成带时间戳的文件名
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_zip_filename = f"user_data_backup_{timestamp}.zip"
    backup_user_data(backup_zip_filename)