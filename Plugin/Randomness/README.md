# Randomness (随机事件生成器) 插件

**版本:** 5.2.0

## 概述

`Randomness` 是一个为 VCPToolbox 设计的多功能后端插件。它提供了一个可靠且易于调用的接口，用于生成各种可信的随机事件。插件现在支持两种主要的操作模式：

1.  **有状态的牌堆管理**: 允许创建、管理和销毁在内存中持久存在的牌堆实例。这对于需要连续抽牌、不可重复抽取的任务（如二十一点游戏、塔罗牌解读）至关重要。
2.  **无状态的随机事件**: 提供原子化的、一次性的随机操作（如单次抽牌、掷骰子），将所有的游戏逻辑和流程控制权完全交给 Agent。

无论是用于复杂的游戏、占卜、数据模拟还是其他任何需要随机性的场景，本插件都能提供强大的支持。

## 更新日志 (Changelog)

### 版本 5.2.0 (2025-07-16)

✨ **符合最新开发手册**:
-   更新 `plugin-manifest.json` 以符合 `v1.0.0` 规范，重写了所有指令的 `description` 以便AI更好地理解和调用。
-   调整了 `main.py` 的返回数据结构，使其更加标准化。

### 版本 5.1.0 (2025-07-09)

✨ **新指令 `selectFromList`**:
-   增加了一个通用的无状态选择器，可以从任意列表中轻松抽取一项或多项，无需管理牌堆实例。完美解决了“今天吃什么”这类日常决策问题。

✨ **新指令 `getRandomDateTime`**:
-   增加了一个可以在指定时间范围内生成随机日期和时间的工具，适用于模拟和创意场景。

🚀 **功能增强 `rollDice`**:
-   为 `rollDice` 指令增加了 `format='ascii'` 选项，现在可以为6面骰生成有趣的ASCII艺术画结果，增强了娱乐性。

🔧 **API & 代码优化**:
-   对 `main.py` 的代码结构进行了优化，统一了函数命名风格。
-   清理了 `config.env` 中未使用的配置项。
-   更新了 `plugin-manifest.json` 以声明所有新功能和参数。

## 功能

### 有状态的牌堆管理

这是插件最强大的功能，允许 Agent 管理一个或多个独立的牌堆实例。

#### 工作流程

1.  **创建牌堆 (`createDeck`)**: 使用指定的牌（如扑克、塔罗牌）创建一个新的牌堆实例。可以指定使用多少副牌。插件会返回一个唯一的 `deckId`。
2.  **从牌堆抽牌 (`drawFromDeck`)**: 使用 `deckId` 从对应的牌堆中抽牌。抽出的牌将从牌堆中移除。
3.  **查询牌堆 (`queryDeck`)**: (可选) 查询牌堆的当前状态，如剩余牌数。
4.  **重置牌堆 (`resetDeck`)**: (可选) 将所有已抽出的牌放回牌堆并重新洗牌。
5.  **销毁牌堆 (`destroyDeck`)**: 任务完成后，**必须**销毁牌堆以释放内存。

---

#### 1. 创建牌堆 (Create Deck)
-   **命令**: `createDeck`
-   **描述**: 创建一个新的、有状态的牌堆实例。
-   **调用示例**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」createDeck「末」,
    deckName:「始」poker「末」,
    deckCount:「始」2「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **参数**:
    -   `deckName` (字符串, **必需**): 要使用的牌堆名称。可用选项: `'poker'`, `'tarot'`。
    -   `deckCount` (整数, 可选, 默认 1): 要混合在一起的牌堆数量。

#### 2. 创建自定义牌堆 (Create Custom Deck)
-   **命令**: `createCustomDeck`
-   **描述**: 根据用户提供的任意卡牌列表创建一个新的、有状态的牌堆实例。
-   **调用示例**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」createCustomDeck「末」,
    cards:「始」["牌1", "牌2", "牌3"]「末」,
    deckName:「始」我的牌堆「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **参数**:
    -   `cards` (数组, **必需**): 一个包含卡牌的数组。
    -   `deckName` (字符串, 可选, 默认 'custom'): 为这个自定义牌堆指定一个名称。

#### 3. 从牌堆抽牌 (Draw From Deck)
-   **命令**: `drawFromDeck`
-   **描述**: 从指定的牌堆实例中抽牌。
-   **调用示例**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」drawFromDeck「末」,
    deckId:「始」a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6「末」,
    count:「始」5「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **参数**:
    -   `deckId` (字符串, **必需**): 由 `createDeck` 返回的牌堆唯一ID。
    -   `count` (整数, 可选, 默认 1): 要抽取的牌的数量。

#### 4. 其他管理命令
-   **`resetDeck`**: 重置牌堆。
-   **`destroyDeck`**: 销毁牌堆。
-   **`queryDeck`**: 查询牌堆状态。

#### 牌堆生命周期和自动清理
-   **生命周期**: 每个创建的牌堆都会在服务器内存中持续存在，直到被明确销毁 (`destroyDeck`)。
-   **自动清理**: 为了防止内存泄漏，插件实现了一个自动清理机制。任何超过 **24小时** 未被访问的牌堆将被自动销毁。

---

### 无状态的随机事件

这些是简单、一次性的操作，不需要进行状态管理。

#### 1. 从列表选择 (Select From List)
-   **命令**: `selectFromList`
-   **描述**: [无状态] 从一个给定的任意列表中随机抽取一个或多个项目。支持重复抽取（有放回）。这是对`createCustomDeck` -> `draw` -> `destroy`流程的简化，非常适合处理日常决策。
-   **调用示例**:
    ```
    // 决定今晚吃什么
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」selectFromList「末」,
    items:「始」["披萨", "寿司", "牛排"]「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **参数**:
    -   `items` (数组, **必需**): 从中进行选择的项目的数组。
    -   `count` (整数, 可选, 默认 1): 要选择的项目的数量。
    -   `withReplacement` (布尔值, 可选, 默认 `false`): 是否允许重复抽取（放回式抽取）。

#### 2. 获取卡牌 (Get Cards)
-   **命令**: `getCards`
-   **描述**: [无状态] 进行一次性的洗牌并抽取指定数量的标准卡牌。
-   **调用示例**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」getCards「末」,
    deckName:「始」poker「末」,
    count:「始」2「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **参数**:
    -   `deckName` (字符串, **必需**): 牌堆名称 (`'poker'`, `'tarot'`)。
    -   `count` (整数, 可选, 默认 1): 抽牌数量。

#### 3. 抽取塔罗牌 (Draw Tarot)
-   **命令**: `drawTarot`
-   **描述**: [无状态] 快捷抽取塔罗牌，支持多种预设的牌阵。
-   **调用示例**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」drawTarot「末」,
    spread:「始」celtic_cross「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **参数**:
    -   `spread` (字符串, 可选): 要使用的牌阵名称。可用选项: `'single_card'`, `'three_card'`, `'celtic_cross'`, ...
    -   `count` (整数, 可选): [兼容旧版] 抽牌数量。
    -   `allowReversed` (布尔值, 可选, 默认 `true`): 是否允许逆位。

#### 4. 抽取卢恩符文 (Cast Runes)
-   **命令**: `castRunes`
-   **描述**: [无状态] 抽取卢恩符文。
-   **调用示例**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」castRunes「末」,
    count:「始」1「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **参数**:
    -   `count` (整数, 可选, 默认 1): 抽取的符文数量。

#### 5. 掷骰子 (Roll Dice) - TRPG 增强版
-   **命令**: `rollDice`
-   **描述**: [无状态] 模拟 TRPG 风格的复杂掷骰表达式。支持视觉化输出。
-   **调用示例**:
    ```
    // D&D 优势检定
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」rollDice「末」,
    diceString:「始」1d20adv+5「末」
    <<<[END_TOOL_REQUEST]>>>

    // ASCII 艺术画输出
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」rollDice「末」,
    diceString:「始」2d6「末」,
    format:「始」ascii「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **参数**:
    -   `diceString` (字符串, **必需**): 要执行的掷骰表达式。
    -   `format` (字符串, 可选, 默认 `text`): 输出格式。可选 `'ascii'` 以获得视觉化结果（目前支持6面骰）。
-   **返回示例 (`ascii` 格式)**:
    ```
    掷骰: **2d6** = **9**
    ┌───────┐   ┌───────┐
    │ ●   ● │   │ ●   ● │
    │   ●   │   │       │
    │ ●   ● │   │ ●   ● │
    └───────┘   └───────┘
    ```
-   **支持的指令**:
    -   基本指令 (`XdY`, `kh/kl`, `s`, `+`, `-`, `>`, `<`, `=`)
    -   特殊指令 (`r` 重复, `dF` Fate骰, `d{...}` 自定义骰面)
    -   游戏专用 (`adv/dis`, `bp/pb`)

#### 6. 获取随机日期时间 (Get Random Date Time)
-   **命令**: `getRandomDateTime`
-   **描述**: [无状态] 在一个指定的开始和结束日期/时间范围内，生成一个随机的时间点。
-   **调用示例**:
    ```
    // 在2025年内随机选择一天
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」getRandomDateTime「末」,
    start:「始」2025-01-01「末」,
    end:「始」2025-12-31「末」,
    format:「始」YYYY-MM-DD「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **参数**:
    -   `start` (字符串, 可选): ISO 8601 格式的起始时间。
    -   `end` (字符串, 可选): ISO 8601 格式的结束时间。
    -   `format` (字符串, 可选): 指定返回日期时间的格式，默认为 `YYYY-MM-DD HH:mm:ss`。

---

## 开发路线图

以下是计划为骰子系统添加的功能，按优先级和技术难度排序。

-   [x] **复杂数学表达式**:
    -   格式: `(表达式)`
    -   示例: `(2d6+5)*2`, `(4d6kh3)/2`
    -   **说明**: 已实现。现在 `rollDice` 指令可以处理包含括号和 `+ - * /` 运算符的完整数学表达式。
-   [ ] **COC 专用指令**:
    -   `sc`: SAN 检定，需要更复杂的逻辑来处理成功/失败的不同结果。
    -   `en`: 技能成长检定。
-   [ ] **暗骰 (Hidden Roll)**:
    -   格式: `hd (表达式)`
    -   需要与 VCPToolbox 的消息机制配合，可能需要新的返回格式。

## 配置文件 (`config.env`)

本插件依赖于外部 JSON 文件来获取数据。这些文件的路径在 `config.env` 文件中进行配置。

-   `TAROT_DECK_PATH`: 塔罗牌数据文件的路径。
-   `RUNE_SET_PATH`: 卢恩符文数据文件的路径。
-   `POKER_DECK_PATH`: 扑克牌数据文件的路径。
-   `TAROT_SPREADS_PATH`: 塔罗牌牌阵数据文件的路径。

---

## Agent 指令与回复示例

本章节提供所有指令的调用示例以及 Agent 可能收到的回复，以便于测试和理解插件的行为。

### 1. `rollDice`

-   **VarUser**: `我的角色要进行一次攻击检定，加值是5，请帮我投一个2d6，然后将结果乘以2作为最终伤害。`
-   **Agent 调用**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」rollDice「末」,
    diceString:「始」(2d6+5)*2「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **预期回复**:
    > 掷骰: **(2d6+5)*2** = **24**
    > `计算过程: 计算 '2d6': 掷骰 (2d6): [4, 6] -> 排序: [4, 6] -> 结果 10 -> 最终计算: (10+5)*2 = 30`
    > *(注意：由于随机性，您的总点数和计算过程会有所不同)*

### 2. `selectFromList`

-   **VarUser**: `我晚饭不知道吃什么，帮我在“红烧牛肉”、“麻婆豆腐”和“宫保鸡丁”里随便选一个。`
-   **Agent 调用**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」selectFromList「末」,
    items:「始」["红烧牛肉", "麻婆豆腐", "宫保鸡丁"]「末」,
    count:「始」1「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **预期回复**:
    > 从列表中随机选择的结果是：**麻婆豆腐**

### 3. `getCards`

-   **VarUser**: `我们来玩德州扑克吧，给我发两张手牌。`
-   **Agent 调用**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」getCards「末」,
    deckName:「始」poker「末」,
    count:「始」2「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **预期回复**:
    > 为您从牌堆中抽到了: AS, KH.

### 4. `drawTarot`

-   **VarUser**: `我想算一下我最近的运势，帮我用三牌阵抽一下塔罗牌。`
-   **Agent 调用**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」drawTarot「末」,
    spread:「始」three_card「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **预期回复**:
    > 为您使用 **three_card** 牌阵抽到的塔罗牌是：
    > - **过去**: 「魔术师」(正位)
    > - **现在**: 「世界」(逆位)
    > - **未来**: 「愚者」(正位)

### 5. `castRunes`

-   **VarUser**: `请为我抽取3个卢恩符文，看看有什么神谕。`
-   **Agent 调用**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」castRunes「末」,
    count:「始」3「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **预期回复**:
    > 为您抽取的卢恩符文是：Fehu, Uruz, Ansuz.

### 6. `getRandomDateTime`

-   **VarUser**: `我想写一个发生在2025年的故事，帮我随机选一个日期，格式是XXXX年XX月XX日。`
-   **Agent 调用**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」getRandomDateTime「末」,
    start:「始」2025-01-01T00:00:00Z「末」,
    end:「始」2025-12-31T23:59:59Z「末」,
    format:「始」%Y年%m月%d日「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **预期回复**:
    > 在指定范围内生成的随机时间是：**2025年08月23日**

### 7. 有状态的牌堆操作 (完整流程)

-   **VarUser (步骤1)**: `我们来玩21点，先创建一个标准的扑克牌堆。`
-   **Agent 调用 (步骤1: 创建)**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」createDeck「末」,
    deckName:「始」poker「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **预期回复 (步骤1)**:
    > 已成功创建牌堆 'poker' (共 52 张)。
    > 请使用此ID进行后续操作: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`

-   **VarUser (步骤2)**: `好了，现在给我发两张牌。`
-   **Agent 调用 (步骤2: 抽牌)**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」drawFromDeck「末」,
    deckId:「始」a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4「末」,
    count:「始」2「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **预期回复 (步骤2)**:
    > 从牌堆 `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4` 中抽到了: QC, 10H.
    > 剩余牌数: 50。

-   **VarUser (步骤3)**: `好的，这局结束了，把牌堆销毁吧。`
-   **Agent 调用 (步骤3: 销毁)**:
    ```
    <<<[TOOL_REQUEST]>>>
    tool_name:「始」Randomness「末」,
    command:「始」destroyDeck「末」,
    deckId:「始」a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4「末」
    <<<[END_TOOL_REQUEST]>>>
    ```
-   **预期回复 (步骤3)**:
    > 牌堆 `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4` 已销毁。

---

## 插件对比: Randomness vs. TarotDivination

本项目中同时存在 `Randomness` 和 `TarotDivination` 两个提供塔罗牌功能的插件，但它们的设计哲学和应用场景完全不同。

-   **`Randomness` (本插件)**:
    -   **定位**: 通用的、无UI的后端随机性服务。
    -   **核心**: 提供公平、不可预测的随机结果，适合游戏、模拟等需要可靠随机源的场景。
    -   **功能**: 一个功能全面的“随机性工具箱”，除塔罗牌外，还支持扑克牌、掷骰、列表选择等。
    -   **状态**: 支持有状态的牌堆管理，可用于连续抽卡。

-   **`TarotDivination`**:
    -   **定位**: 专用的、注重前端体验的占卜应用。
    -   **核心**: 使用基于环境因素（天气、时间等）的算法，旨在创造一种充满仪式感的占卜体验。
    -   **功能**: 专注于塔罗牌占卜的深度体验，并深度绑定前端视觉效果。
    -   **状态**: 无状态，每次调用都是一次独立的占卜。

**结论**: `Randomness` 是一个功能强大的后端随机性引擎，而 `TarotDivination` 则是一个体验驱动的前端占卜应用。两者互为补充，而非竞争关系。