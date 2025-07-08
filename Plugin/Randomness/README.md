# Randomness (随机事件生成器) 插件

**版本:** 1.0.0

## 概述

`Randomness` 是一个为 VCPToolbox 设计的多功能后端插件。它的核心功能是提供一个可靠且易于调用的接口，用于生成各种可信的随机事件。无论是用于游戏、占卜、数据模拟还是其他任何需要随机性的场景，本插件都能提供强大的支持。

本插件旨在实现与 Agent 的纯自然语言交互，Agent 无需构造任何 JSON 对象即可调用所有功能。

## 功能

### 1. 掷骰子 (Dice Rolling)

模拟掷一个或多个多面骰子的过程。

-   **命令**: `rollDice`
-   **调用示例**:
    ```
    VCP>Randomness.rollDice count=2 sides=20
    ```
-   **参数**:
    -   `count` (整数, 可选, 默认 1): 要掷的骰子数量。
    -   `sides` (整数, 可选, 默认 6): 每个骰子的面数。
-   **返回信息 (`messageForAI`)**:
    `为您掷出了 2 个 20 面的骰子，结果为：15, 8。总点数为：23。`

### 2. 抽取塔罗牌 (Tarot Draw)

从一副标准的塔罗牌中抽取指定数量的牌。

-   **命令**: `drawTarot`
-   **调用示例**:
    ```
    VCP>Randomness.drawTarot count=3 allow_reversed=true
    ```
-   **参数**:
    -   `count` (整数, 可选, 默认 3): 要抽取的塔罗牌数量。
    -   `allow_reversed` (布尔值, 可选, 默认 `true`): 是否允许出现逆位牌。
-   **返回信息 (`messageForAI`)**:
    `为您抽到的塔罗牌是：\n「The Fool」(正位)\n「The Magician」(逆位)`

### 3. 发扑克牌 (Poker Deal)

模拟发扑克牌的过程，可以指定玩家数量和每个玩家的手牌数。

-   **命令**: `dealPoker`
-   **调用示例**:
    ```
    VCP>Randomness.dealPoker players=3 cards_per_player=17
    ```
-   **参数**:
    -   `players` (整数, 可选, 默认 1): 玩家数量。
    -   `cards_per_player` (整数, 可选, 默认 2): 每个玩家发的手牌数量。
-   **返回信息 (`messageForAI`)**:
    `为您向 3 位玩家发牌，结果如下：\n玩家 1: [...]\n玩家 2: [...]\n玩家 3: [...]\n\n底牌: [Joker_red, Joker_black, ...]`

### 4. 抽取卢恩符文 (Rune Cast)

从一套卢恩符文中抽取指定数量的符文。

-   **命令**: `castRunes`
-   **调用示例**:
    ```
    VCP>Randomness.castRunes count=1
    ```
-   **参数**:
    -   `count` (整数, 可选, 默认 1): 要抽取的卢恩符文数量。
-   **返回信息 (`messageForAI`)**:
    `为您抽取的卢恩符文是：Fehu。`

## 配置文件 (`config.env`)

本插件依赖于外部 JSON 文件来获取数据（如塔罗牌、扑克牌和卢恩符文的定义）。这些文件的路径在 `config.env` 文件中进行配置。

-   `TAROT_DECK_PATH`: 塔罗牌数据文件的路径。
-   `RUNE_SET_PATH`: 卢恩符文数据文件的路径。
-   `POKER_DECK_PATH`: 扑克牌数据文件的路径。

请确保这些路径相对于项目根目录 (`/opt/VCPToolBox`) 是正确的。