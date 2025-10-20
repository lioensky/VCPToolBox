import os
import json
from collections import OrderedDict
from datetime import datetime

def process_timeline_file(input_path, output_path):
    """
    读取一个 timeline.json 文件，按日期排序条目，
    并将结果以 Markdown 格式写入一个新的 .txt 文件。
    """
    try:
        with open(input_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        entries = data.get('entries')
        if not entries:
            print(f"在 {input_path} 中未找到任何条目，已跳过。")
            return

        # 按升序（最早优先）对日期进行排序
        # Python 3.7+ dicts preserve insertion order, but sorting keys is more robust.
        sorted_dates = sorted(entries.keys(), key=lambda date_str: datetime.strptime(date_str, '%Y-%m-%d'))

        # 将处理后的内容写入输出文件
        with open(output_path, 'w', encoding='utf-8') as f:
            character_name = data.get('character', '未知角色')
            last_updated = data.get('lastUpdated', '未知')
            
            # 写入文件头信息
            f.write(f"# {character_name}的时间线\n")
            f.write(f"> 最后更新: {last_updated}\n")
            f.write("---\n\n")

            for i, date in enumerate(sorted_dates):
                f.write(f"## {date}\n")
                for entry in entries[date]:
                    summary = entry.get('summary', '无有效总结').strip().rstrip('。<')
                    f.write(f"- {summary}\n")
                
                # 在日期块之间添加一个空行以提高可读性，但最后一个块后面不加
                if i < len(sorted_dates) - 1:
                    f.write("\n")
        
        print(f"成功处理 '{input_path}' -> '{output_path}'")

    except FileNotFoundError:
        print(f"错误: 在 {input_path} 未找到输入文件")
    except json.JSONDecodeError:
        print(f"错误: 无法解析 {input_path} 中的 JSON 数据。")
    except Exception as e:
        print(f"处理 {input_path} 时发生错误: {e}")


def main():
    """
    主函数，用于查找和处理所有时间线JSON文件。
    """
    input_dir = 'timeline'
    output_dir = 'timeline已整理'

    if not os.path.exists(input_dir):
        os.makedirs(input_dir)
        print(f"已创建输入目录: '{input_dir}'")
        print("请确保您的 'XXX_timeline.json' 文件在此目录中，然后再次运行脚本。")
        return

    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        print(f"已创建输出目录: '{output_dir}'")

    processed_count = 0
    for filename in os.listdir(input_dir):
        if filename.endswith("_timeline.json"):
            input_file_path = os.path.join(input_dir, filename)
            # 将输出文件的扩展名更改为 .txt
            output_filename = filename.replace('_timeline.json', '_timeline.txt')
            output_file_path = os.path.join(output_dir, output_filename)
            process_timeline_file(input_file_path, output_file_path)
            processed_count += 1
    
    if processed_count == 0:
        print(f"在 '{input_dir}' 目录中没有找到需要处理的 'XXX_timeline.json' 文件。")


if __name__ == "__main__":
    main()
    print("\n时间线整理完成。")