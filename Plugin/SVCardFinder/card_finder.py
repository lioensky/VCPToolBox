import sys
import json
import requests
from urllib.parse import urlencode

def main():
    try:
        input_data = sys.stdin.read()
        args = json.loads(input_data)

        base_url = "https://shadowverse-wb.com/web/CardList/cardList"
        
        if 'class' not in args:
            args['class'] = '0,1,2,3,4,5,6,7'
        if 'cost' not in args:
            args['cost'] = '0,1,2,3,4,5,6,7,8,9,10'

        params = {}
        for key, value in args.items():
            if isinstance(value, list):
                params[key] = ','.join(map(str, value))
            else:
                params[key] = value
        
        query_string = urlencode(params)
        full_url = f"{base_url}?{query_string}"

        headers = {
            'accept': 'application/json, text/plain, */*',
            'lang': 'chs',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/5.37.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
        }

        response = requests.get(full_url, headers=headers)
        response.raise_for_status()
        
        data = response.json()

        if data.get("data_headers", {}).get("result_code") != 1:
            raise Exception("API返回错误: " + json.dumps(data))

        card_details = data.get("data", {}).get("card_details", {})
        count = data.get("data", {}).get("count", 0)

        if not card_details:
            result_text = "### 未找到符合条件的卡牌。\n请检查你的查询参数是否正确。"
        else:
            result_text = f"### 查询到 {count} 张卡牌，显示部分结果：\n"
            for card_id, details in card_details.items():
                common = details.get("common", {})
                img_hash = common.get("card_image_hash")
                img_url = f"https://shadowverse-wb.com/uploads/card_image/chs/card/{img_hash}.png" if img_hash else ""

                skill_text = common.get('skill_text', '').replace('<color=Keyword>', '**').replace('</color>', '**').replace('\\n', ' ').replace('<ev>', ' ').replace('</ev>', ' ').replace('<sev>', ' ').replace('</sev>', ' ').replace('<hr>', ' ')
                flavour_text = common.get('flavour_text', '').replace('\\n', ' ')

                result_text += f"名称: {common.get('name', 'N/A')}  "
                result_text += f"ID: {common.get('card_id', 'N/A')}"
                result_text += f"费用: {common.get('cost', 'N/A')}  身材: {common.get('atk', 'N/A')}/{common.get('life', 'N/A')}"
                result_text += f"描述: {skill_text}"
                result_text += f"风味: *{flavour_text}*"
                if img_url:
                    # 修正 f-string 表达式跨行导致的语法错误
                    result_text += f"卡图: [{common.get('name')}]({img_url})"
                result_text += "\n"

        output = {"status": "success", "result": result_text}

    except Exception as e:
        input_data_str = "Not available"
        try:
            input_data_str = json.dumps(args)
        except:
            pass
        output = {"status": "error", "error": f"插件执行失败: {str(e)}\\n输入参数: {input_data_str}"}

    print(json.dumps(output, ensure_ascii=False))
    sys.exit(0)

if __name__ == "__main__":
    main()