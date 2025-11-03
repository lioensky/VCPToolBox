[根目录](../../../CLAUDE.md) > [Plugin](../) > **DailyHot**

# DailyHot 插件

## 模块职责

DailyHot 是一个静态数据插件，专门用于获取和提供每日热门内容信息。它能够获取多个平台的热门榜单，为AI提供最新的热门趋势和话题参考。

## 入口与启动

- **入口文件**: `main.py`
- **启动命令**: 通过VCP协议调用 `「始」DailyHot「末」`
- **插件类型**: 静态插件
- **通信协议**: stdio
- **处理方式**: 同步执行，立即返回结果

## 对外接口

### 主要功能
- **热门榜单**: 支持多平台热门内容获取
- **分类信息**: 提供不同分类的热门内容
- **实时更新**: 支持定时更新热门数据
- **格式化输出**: 结构化数据便于AI理解

### 调用示例
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」DailyHot「末」,
platform:「始」bilibili「末」,
category:「始」all「末」
<<<[END_TOOL_REQUEST]>>>
```

## 关键依赖与配置

### 依赖项
- Python 3.7+
- requests 库
- JSON 解析库

### 配置文件
- **插件清单**: `plugin-manifest.json`
- **配置文件**: `config.env` (可配置各种API密钥)

### 配置项
```env
BILIBILI_API_KEY=your_bilibili_api_key
DOUYIN_API_KEY=your_douyin_api_key
WEIBO_API_KEY=your_weibo_api_key
UPDATE_INTERVAL=3600  # 更新间隔(秒)
```

## 数据模型

### 支持的平台
- **B站**: bilibili
- **抖音**: douyin
- **微博**: weibo
- **知乎**: zhihu
- **GitHub**: github

### 数据分类
- **综合**: all
- **科技**: tech
- **娱乐**: entertainment
- **游戏**: game
- **时事**: news

### 响应结构
```json
{
  "success": true,
  "platform": "bilibili",
  "category": "all",
  "data": [
    {
      "title": "热门标题1",
      "description": "描述",
      "url": "链接",
      "heat": 9999,
      "timestamp": "2025-10-30T12:00:00Z"
    }
  ],
  "update_time": "2025-10-30T12:00:00Z"
}
```

## 测试与质量

### 测试建议
1. 测试各平台数据获取功能
2. 验证分类过滤效果
3. 测试定时更新机制
4. 验证错误处理和重试逻辑

### 性能优化
- 数据缓存机制避免频繁API调用
- 异步数据更新
- 智能更新频率控制
- 错误重试机制

## 常见问题 (FAQ)

1. **API调用失败怎么办？**
   - 检查API密钥配置是否正确
   - 验证网络连接和防火墙设置
   - 查看API调用频率限制

2. **数据更新不及时？**
   - 调整UPDATE_INTERVAL配置
   - 检查定时任务是否正常运行
   - 验证API服务状态

3. **某些平台数据为空？**
   - 确认平台API服务状态
   - 检查数据获取权限
   - 尝试手动刷新数据

## 相关文件清单

```
Plugin/DailyHot/
├── main.py                     # 主入口文件
├── plugin-manifest.json        # 插件清单
├── config.env.example          # 配置文件模板
├── cache.json                # 热门数据缓存
├── platforms/               # 各平台适配器
│   ├── bilibili.py       # B站API
│   ├── douyin.py         # 抖音API
│   └── weibo.py          # 微博API
└── README.md               # 插件说明
```

## 变更记录 (Changelog)

### 2025-10-30 20:05:05 - AI上下文初始化
- 创建DailyHot插件文档
- 添加导航面包屑系统
- 完善插件接口和配置说明