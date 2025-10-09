[根目录](../../../CLAUDE.md) > [Plugin](../) > **Randomness**

# Randomness 插件

## 面包屑导航
[根目录](../../../CLAUDE.md) > [Plugin](../) > **Randomness**

## 模块职责

Randomness（随机事件生成器）是一个多功能后端插件，用于生成各种可信的随机事件。它支持无状态的单次随机事件（如抽牌、掷骰）和有状态的、可持久化的牌堆管理（创建、抽取、重置、销毁），适用于需要连续操作的场景。

## 入口与启动

- **入口文件**: `main.py`
- **启动命令**: `python main.py`
- **插件类型**: 同步插件
- **通信协议**: stdio
- **超时设置**: 10000ms

## 对外接口

### 核心命令

1. **createDeck** - 创建有状态牌堆
   - 用于创建一个新的、有状态的牌堆实例，支持后续连续抽牌操作
   - 支持poker、tarot等牌堆类型

2. **createCustomDeck** - 创建自定义牌堆
   - 根据用户提供的任意卡牌列表创建自定义牌堆

3. **drawFromDeck** - 从牌堆抽牌
   - 从已创建的有状态牌堆中抽取指定数量的牌

4. **resetDeck** - 重置牌堆
   - 将所有已抽出的牌放回牌堆并重新洗牌

5. **destroyDeck** - 销毁牌堆
   - 将牌堆从内存中移除以释放资源

6. **queryDeck** - 查询牌堆状态
   - 查询牌堆的当前状态（剩余牌数、已抽牌数等）

7. **getCards** - 无状态抽牌
   - 从完整牌堆中进行一次性洗牌并抽牌

8. **rollDice** - 复杂掷骰表达式
   - 支持TRPG风格的掷骰表达式，包括加减乘除、括号、取高/低、优势/劣势、CoC奖惩骰等

9. **drawTarot** - 塔罗牌占卜
   - 支持多种预设牌阵或指定抽牌数量

10. **castRunes** - 卢恩符文占卜
    - 从符文集中抽取指定数量的卢恩符文

11. **selectFromList** - 列表随机选择
    - 从给定的任意列表中随机抽取一个或多个项目

12. **getRandomDateTime** - 随机时间生成
    - 在指定的时间范围内生成随机时间点

## 关键依赖与配置

### 配置文件
- **主配置**: `config.env.example` (需要复制为`config.env`并填写实际值)
- **插件清单**: `plugin-manifest.json`

### 配置项
```json
{
  "TAROT_DECK_PATH": "塔罗牌数据文件路径",
  "RUNE_SET_PATH": "符文数据文件路径",
  "POKER_DECK_PATH": "扑克牌数据文件路径",
  "TAROT_SPREADS_PATH": "塔罗牌阵数据文件路径"
}
```

### 依赖项
- Python 3.x
- requirements.txt 中定义的Python包

## 数据模型

插件使用JSON格式的数据文件存储各种牌组和符文集合：
- `data/tarot_deck.json` - 塔罗牌数据
- `data/rune_set.json` - 符文集合数据
- `data/poker_deck.json` - 扑克牌数据
- `data/tarot_spreads.json` - 塔罗牌阵数据

## 测试与质量

### 测试文件
目前未发现专门的测试文件，建议添加：
- `test_main.py` - 主功能测试
- `test_dice_roller.py` - 骰子功能测试

### 质量工具
- 暂无发现代码质量工具配置

## 常见问题 (FAQ)

1. **如何使用插件？**
   - 通过VCP工具调用协议进行调用，格式见插件清单中的调用示例

2. **牌堆数据存储在哪里？**
   - 牌堆数据存储在插件目录下的data文件夹中，使用JSON格式

3. **支持哪些类型的骰子？**
   - 支持复杂的TRPG掷骰表达式，包括多面骰、加减运算、括号、取高/低等

4. **如何创建自定义牌组？**
   - 使用createCustomDeck命令，提供卡牌列表JSON数组

## 相关文件清单

```
Plugin/Randomness/
├── main.py                    # 主入口文件
├── dice_roller.py            # 骰子功能实现
├── plugin-manifest.json      # 插件清单
├── config.env.example        # 配置文件模板
├── requirements.txt          # Python依赖
├── README.md                 # 插件说明
└── data/                     # 数据文件目录
    ├── tarot_deck.json
    ├── rune_set.json
    ├── poker_deck.json
    └── tarot_spreads.json
```

## 变更记录 (Changelog)

### 2025-09-30 20:07:41 - AI上下文初始化
- 创建Randomness插件文档
- 添加导航面包屑
- 完善插件功能和配置说明