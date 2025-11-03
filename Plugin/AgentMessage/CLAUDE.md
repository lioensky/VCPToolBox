[根目录](../../../CLAUDE.md) > [Plugin](../) > **AgentMessage**

# AgentMessage 插件

## 模块职责

AgentMessage 是一个消息预处理器插件，专门用于多智能体协作场景下的消息推送和路由。它能够识别消息中的智能体标识，实现智能化的消息分发和处理，支持复杂的多Agent工作流。

## 入口与启动

- **入口文件**: `agent-message.js`
- **启动命令**: 自动作为消息预处理器加载
- **插件类型**: 消息预处理器
- **通信协议**: stdio
- **处理流程**: 在AI处理消息前自动执行

## 对外接口

### 主要功能
- **Agent识别**: 自动识别消息中的Agent标识
- **消息路由**: 智能路由消息到对应的Agent
- **上下文注入**: 为不同Agent注入特定上下文
- **协作协调**: 管理多Agent协作的通信流程

### 支持的Agent标识
- **@Nova**: 测试AI代理
- **@ThemeMaidCoco**: 主题女仆
- **@ComfyUIArtist**: ComfyUI艺术家
- **@JibrilComfyResearch**: ComfyUI研究员
- **@MemoriaSorter**: 记忆整理者
- **@Metis**: 智慧顾问
- **@Hornet**: 黄蜂特工
- **@MagiAgent**: 魔法代理

### 调用示例
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgentMessage「末」,
message:「始」@ThemeMaidCoco 请帮我设计一个动漫主题「末」,
target_agent:「始」ThemeMaidCoco「末」,
context:「始」设计相关的专业上下文「末」
<<<[END_TOOL_REQUEST]>>>
```

## 关键依赖与配置

### 配置文件
- **插件清单**: `plugin-manifest.json`
- **Agent配置**: `agent-config.json`

### 配置项
```env
AGENT_ROUTING_ENABLED=true
CONTEXT_INJECTION=true
COLLABORATION_MODE=multi_agent
MESSAGE_LOGGING=true
```

### Agent配置结构
```json
{
  "agents": {
    "Nova": {
      "specialty": "测试和验证",
      "context_file": "Agent/Nova.txt",
      "keywords": ["测试", "验证", "调试"]
    },
    "ThemeMaidCoco": {
      "specialty": "主题设计和规划",
      "context_file": "Agent/ThemeMaidCoco.txt",
      "keywords": ["设计", "主题", "规划", "创意"]
    }
  }
}
```

## 数据模型

### 消息处理流程
1. **Agent识别**: 扫描消息中的@标识
2. **上下文加载**: 加载对应Agent的配置文件
3. **消息增强**: 注入Agent特定的上下文信息
4. **路由处理**: 将增强后的消息发送给目标Agent
5. **响应收集**: 收集Agent的响应并格式化

### 消息增强模式
- **简单模式**: 仅添加Agent标识
- **上下文模式**: 注入完整Agent上下文
- **协作模式**: 支持多Agent协作对话
- **专业模式**: 针对Agent专业能力优化

## 测试与质量

### 测试建议
1. 测试Agent识别准确性
2. 验证消息路由功能
3. 测试上下文注入效果
4. 验证多Agent协作流程

### 性能优化
- Agent标识缓存机制
- 上下文预加载
- 消息批处理
- 异步响应处理

## 常见问题 (FAQ)

1. **Agent识别不准确怎么办？**
   - 检查Agent配置中的关键词设置
   - 更新Agent标识列表
   - 优化消息解析算法

2. **消息路由失败？**
   - 验证目标Agent是否在线
   - 检查消息格式是否符合要求
   - 查看路由配置是否正确

3. **上下文注入无效？**
   - 检查Agent配置文件是否存在
   - 验证CONTEXT_INJECTION是否启用
   - 确认上下文文件格式正确

## 相关文件清单

```
Plugin/AgentMessage/
├── agent-message.js           # 主入口文件
├── plugin-manifest.json      # 插件清单
├── config.env.example        # 配置文件模板
├── agent-config.json         # Agent配置文件
├── agents/                   # Agent处理器目录
│   ├── nova-handler.js       # Nova处理器
│   ├── theme-handler.js      # 主题处理器
│   └── agent-router.js       # 消息路由器
├── context/                  # 上下文模板
│   ├── default-context.json  # 默认上下文
│   └── professional-context.json # 专业上下文
└── README.md                 # 插件说明
```

## 变更记录 (Changelog)

### 2025-10-30 20:05:05 - AI上下文初始化
- 创建AgentMessage插件文档
- 添加导航面包屑系统
- 完善插件接口和配置说明