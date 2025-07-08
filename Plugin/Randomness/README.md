# Randomness (随机事件生成器) 插件

**版本:** 5.0.0

## 概述

`Randomness` 是一个为 VCPToolbox 设计的多功能后端插件。它提供了一个可靠且易于调用的接口，用于生成各种可信的随机事件。插件现在支持两种主要的操作模式：

1.  **有状态的牌堆管理**: 允许创建、管理和销毁在内存中持久存在的牌堆实例。这对于需要连续抽牌、不可重复抽取的任务（如二十一点游戏、塔罗牌解读）至关重要。
2.  **无状态的随机事件**: 提供原子化的、一次性的随机操作（如单次抽牌、掷骰子），将所有的游戏逻辑和流程控制权完全交给 Agent。

无论是用于复杂的游戏、占卜、数据模拟还是其他任何需要随机性的场景，本插件都能提供强大的支持。

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
    VCP>Randomness.createDeck deckName=poker deckCount=2
    ```
-   **参数**:
    -   `deckName` (字符串, **必需**): 要使用的牌堆名称。可用选项: `'poker'` (使用国际缩写, 如 S13 代表黑桃K), `'tarot'`。
    -   `deckCount` (整数, 可选, 默认 1): 要混合在一起的牌堆数量。
-   **返回信息 (`messageForAI`)**:
    `已成功创建牌堆 'poker' (共 104 张)。\n请使用此ID进行后续操作: \`a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6\``
-   **注意**: `createDeck` 命令只返回牌堆的元数据，不包含任何牌的内容。

#### 2. 从牌堆抽牌 (Draw From Deck)

-   **命令**: `drawFromDeck`
-   **描述**: 从指定的牌堆实例中抽牌。
-   **调用示例**:
    ```
    VCP>Randomness.drawFromDeck deckId=a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6 count=5
    ```
-   **参数**:
    -   `deckId` (字符串, **必需**): 由 `createDeck` 返回的牌堆唯一ID。
    -   `count` (整数, 可选, 默认 1): 要抽取的牌的数量。
-   **返回信息 (`messageForAI`)**:
    `从牌堆 \`a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6\` 中抽到了: KS, AH, 2C, 9D, 10H。\n剩余牌数: 99。`

#### 3. 其他管理命令

-   **`resetDeck`**: 重置牌堆。
    -   `VCP>Randomness.resetDeck deckId=...`
-   **`destroyDeck`**: 销毁牌堆。
    -   `VCP>Randomness.destroyDeck deckId=...`
-   **`queryDeck`**: 查询牌堆状态。
    -   `VCP>Randomness.queryDeck deckId=...`

#### 5. 创建自定义牌堆 (Create Custom Deck)

-   **命令**: `createCustomDeck`
-   **描述**: 根据用户提供的任意卡牌列表创建一个新的、有状态的牌堆实例。
-   **调用示例**:
    ```
    VCP>Randomness.createCustomDeck cards=["牌1", "牌2", "牌3"] deckName=我的牌堆
    ```
-   **参数**:
    -   `cards` (数组, **必需**): 一个包含卡牌的数组。
    -   `deckName` (字符串, 可选, 默认 'custom'): 为这个自定义牌堆指定一个名称。

#### 牌堆生命周期和自动清理

-   **生命周期**: 每个创建的牌堆都会在服务器内存中持续存在，直到被明确销毁 (`destroyDeck`)。
-   **自动清理**: 为了防止内存泄漏，插件实现了一个自动清理机制。任何超过 **24小时** 未被访问（通过 `drawFromDeck`, `resetDeck`, 或 `queryDeck` 等命令）的牌堆将被自动销毁。

---

### 无状态的随机事件

这些是简单、一次性的操作，不需要进行状态管理。

#### 1. 获取卡牌 (Get Cards)

-   **命令**: `getCards`
-   **描述**: [无状态] 进行一次性的洗牌并抽取指定数量的卡牌。
-   **调用示例**:
    ```
    VCP>Randomness.getCards deckName=poker count=2
    ```
-   **参数**:
    -   `deckName` (字符串, **必需**): 牌堆名称 (`'poker'` (使用国际缩写, 如 S13 代表黑桃K), `'tarot'`)。
    -   `count` (整数, 可选, 默认 1): 抽牌数量。

#### 2. 抽取塔罗牌 (Draw Tarot)

-   **命令**: `drawTarot`
-   **描述**: [无状态] 快捷抽取塔罗牌。
-   **调用示例**:
    ```
    VCP>Randomness.drawTarot count=3 allow_reversed=true
    ```
-   **参数**:
    -   `count` (整数, 可选, 默认 3): 抽牌数量。
    -   `allow_reversed` (布尔值, 可选, 默认 `true`): 是否允许逆位。

#### 3. 掷骰子 (Roll Dice)

-   **命令**: `rollDice`
-   **描述**: [无状态] 模拟掷骰子。
-   **调用示例**:
    ```
    VCP>Randomness.rollDice count=2 sides=20
    ```
-   **参数**:
    -   `count` (整数, 可选, 默认 1): 骰子数量。
    -   `sides` (整数, 可选, 默认 6): 骰子面数。

#### 4. 抽取卢恩符文 (Rune Cast)

-   **命令**: `castRunes`
-   **描述**: [无状态] 抽取卢恩符文。
-   **调用示例**:
    ```
    VCP>Randomness.castRunes count=1
    ```
-   **参数**:
    -   `count` (整数, 可选, 默认 1): 抽取的符文数量。

## 配置文件 (`config.env`)

本插件依赖于外部 JSON 文件来获取数据（如塔罗牌、扑克牌和卢恩符文的定义）。这些文件的路径在 `config.env` 文件中进行配置。

-   `TAROT_DECK_PATH`: 塔罗牌数据文件的路径。
-   `RUNE_SET_PATH`: 卢恩符文数据文件的路径。
-   `POKER_DECK_PATH`: 扑克牌数据文件的路径。

请确保这些路径相对于项目根目录 (`/opt/VCPToolBox`) 是正确的。