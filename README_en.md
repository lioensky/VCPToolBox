[简体中文](README.md) | [日本語](README_ja.md) | [Русский](README_ru.md)

---
# VCP (Variable & Command Protocol) - AI Capability Enhancement Middleware Toolkit (English Version - Please Replace with Actual Translation)

## Project Vision

VCP aims to build a middleware layer that transcends traditional AI interaction modes. It is a highly compatible, universal, and extensible toolkit dedicated to empowering AI models to seamlessly interact with external APIs, services, and custom logic. Our goal is to create a powerful VCP (Variable & Command Protocol) system applicable to almost all API ports and clients, significantly expanding the application boundaries of AI.

### *Warning: Do not use unofficial APIs (e.g., reverse proxy intermediaries) to call this toolkit to avoid irreparable information leakage.*

## Core Features

*   **Powerful Plugin Architecture**: Easily integrate and manage various functional modules through a well-defined plugin manifest (`plugin-manifest.json`) and a core plugin manager (`Plugin.js`).
*   **VCP Protocol**: AI invokes plugins by embedding specifically formatted instructions (`<<<[TOOL_REQUEST]>>> ... <<<[END_TOOL_REQUEST]>>>`) in its responses. Parameters use the `key:「始」value「末」` format, supporting complex data types and multi-line text.
*   **Support for Multiple Plugin Types**:
    *   **Static Plugins (`static`)**: Provide dynamic information (like weather, custom data) to replace placeholders in system prompts, supporting scheduled refreshes.
    *   **Message Preprocessor Plugins (`messagePreprocessor`)**: Modify or enhance message content (e.g., image recognition and description) before user requests are sent to the AI model.
    *   **Synchronous Plugins (`synchronous`)**: AI can call these plugins during a conversation to perform specific tasks (e.g., scientific calculations, image generation, video generation). The server waits for plugin execution to complete and feeds the results back to the AI for further processing.
    *   **Service Plugins (`service`)**: Allow plugins to register independent HTTP routes with the main application, providing additional service interfaces (e.g., image hosting service).
*   **Flexible Configuration Management**: Supports global configuration files (`config.env`) and plugin-specific `.env` files, enabling hierarchical and isolated configurations.
*   **Universal Variable Replacement**: Automatically replaces predefined placeholder variables at various stages of interaction with AI (system prompts, user messages).
*   **Built-in Utility Functions (Partially Pluginized)**:
    *   **Diary/Memory System**: Reads diary entries via `DailyNoteGet` (static plugin) and stores AI-generated structured diaries via `DailyNoteWrite` (synchronous plugin). Related content is injected into prompts via `{{角色名日记本}}` and `{{AllCharacterDiariesData}}` placeholders.
    *   **Dynamic Emoji System**: `EmojiListGenerator` (static plugin) scans the `image/` directory and generates emoji list `.txt` files within its plugin directory. The server executes this plugin at startup and loads these lists into memory cache for use by `{{xx表情包}}` placeholders.
    *   **Prompt Transformation**: Supports rule-based replacement of system prompts and global context text.
*   **Tool Invocation Capability**:
    *   **Non-streaming Mode**: Implemented cyclical processing and result feedback for **multiple** tool call instructions contained in a single AI response.
    *   **Streaming Mode (SSE)**: Implemented cyclical processing and result feedback for **multiple** tool call instructions contained in a single AI response. AI replies and VCP tool results (if the `SHOW_VCP_OUTPUT` environment variable is set to `true`) are streamed incrementally to the client until there are no more tool calls or the maximum loop count is reached.
*   **Debugging and Logging**: Provides a debug mode and detailed logging for easier development and troubleshooting.

## System Architecture Overview

1.  **Client Request**: The client sends a request to the VCP server's `/v1/chat/completions` endpoint.
2.  **`server.js` (Core Server)**:
    *   Receives the request, performs initial processing (e.g., authentication, variable replacement).
    *   Calls `messagePreprocessor` plugins (e.g., `ImageProcessor`) to process the user message.
    *   Forwards the processed request to the backend AI model.
3.  **AI Model Response**: The AI model returns a response.
4.  **`server.js` Processes AI Response**:
    *   Detects if the AI response contains VCP tool call instructions (`<<<[TOOL_REQUEST]>>>`).
    *   If tool calls are present:
        *   Parses the instructions, extracts tool names and parameters.
        *   Calls `PluginManager` to execute the corresponding `synchronous` plugins.
5.  **`Plugin.js` (Plugin Manager)**:
    *   Finds loaded plugins based on tool names.
    *   Prepares the execution environment and configuration for plugins.
    *   Interacts with plugin scripts via `stdio` (or other protocols), sending input and receiving output (e.g., `DailyNoteWrite` plugin receives diary data via stdin, `SciCalculator` receives calculation expressions).
    *   Returns the plugin's execution result (usually JSON) to `server.js`.
6.  **`server.js` Secondary AI Call**:
    *   Formats the plugin's execution result and adds it as a new user message to the conversation history.
    *   Calls the backend AI model again, sending the complete conversation history including the plugin result.
    *   Returns the AI's final response to the client, either streaming or non-streaming.
7.  **Static and Service Plugins**:
    *   `static` plugins are called by `PluginManager` at server startup and/or via scheduled tasks. They can:
        *   Directly update placeholder variables, like `WeatherReporter` (providing weather info to `{{VCPWeatherInfo}}`) or `DailyNoteGet` (providing all diary data to `{{AllCharacterDiariesData}}`).
        *   Perform specific tasks, like `EmojiListGenerator`, which is called during initialization to generate emoji list `.txt` files that are then loaded into memory cache by the server.
    *   `service` plugins (e.g., `ImageServer`) are initialized by `PluginManager` at server startup and register their own routes with the Express application.

## Web Admin Panel

To facilitate user management of server configuration and plugins, the project includes a simple web admin panel.

**Main Features**:

*   **Main Configuration Management**: Preview and edit the content of the `config.env` file in the project root directory online.
    *   **Note**: For security reasons, the admin interface automatically hides the `AdminUsername` and `AdminPassword` fields when displaying the main configuration. When saving, the system merges your modified content with the original sensitive field values on the server to ensure credentials are not lost.
    *   **Important**: After saving changes to `config.env`, **you usually need to manually restart the server** for all changes (e.g., port, API keys, plugin-specific configurations) to take full effect. The server currently does not restart automatically.
*   **Plugin Management**:
    *   **List & Status**: Displays all discovered plugins in the `Plugin/` directory and their enabled/disabled status.
    *   **Description Editing**: Directly edit the description information in each plugin's `plugin-manifest.json` file via the interface.
    *   **Enable/Disable Plugins**: Toggle plugin enablement status via an interface switch (achieved by renaming the plugin's `plugin-manifest.json` to `plugin-manifest.json.block` or vice versa).
    *   **Plugin Configuration**: Read and edit `config.env` files within individual plugin directories (if they exist).

**Access & Login**:

1.  **Set Credentials**: Before first use, ensure you have set the following two variables in the `config.env` file in the project root:
    ```env
    AdminUsername=your_admin_username
    AdminPassword=your_admin_password
    ```
    **Important**: If `AdminUsername` or `AdminPassword` is not set, the admin panel and its API will be inaccessible and will return a 503 Service Unavailable error. These credentials must be configured to enable the admin panel.
2.  **Access Address**: After starting the server, access `http://<your_server_IP_or_domain>:<port>/AdminPanel` via a browser.
3.  **Login**: The browser will pop up an HTTP Basic Auth authentication window. Enter the `AdminUsername` and `AdminPassword` you set in `config.env` to log in.

## Implemented Plugin Examples

*   **`WeatherReporter` (`static`)**: Fetches and caches weather information for use by the `{{VCPWeatherInfo}}` variable.
*   **`ImageProcessor` (`messagePreprocessor`)**: Automatically translates Base64 images in user messages into text descriptions and caches them.
*   **`SciCalculator` (`synchronous`)**: Provides scientific calculation capabilities, supporting mathematical functions, statistics, and calculus.
*   **`ImageServer` (`service`)**: Provides a static image hosting service with key authentication.
*   **`FluxGen` (`synchronous`)**: Integrates SiliconFlow API for text-to-image generation and saves images to the local server.
*   **`Wan2.1VideoGen` (`synchronous`)**: Integrates SiliconFlow Wan2.1 API for text-to-video and image-to-video generation.
*   **`SunoGen` (`synchronous`)**: Integrates Suno API to generate original songs, supporting custom lyrics/style, inspirational descriptions, or continuation mode.
*   **`TavilySearch` (`synchronous`)**: Integrates Tavily API to provide web search capabilities.
*   **`DailyNoteGet` (`static`)**: Periodically reads diaries of all characters in the `dailynote/` directory and provides them to the server via the `{{AllCharacterDiariesData}}` placeholder to support parsing of `{{角色名日记本}}`.
*   **`DailyNoteWrite` (`synchronous`)**: Receives diary data (via stdin) containing character name, date, and content, and writes it to the corresponding diary file.
*   **`EmojiListGenerator` (`static`)**: Scans emoji folders in the project's `image/` directory and generates corresponding `.txt` list files in the plugin's own `generated_lists/` directory for server loading and use.

## How to Load Plugins
*   **Simply define the following fields in the system prompt, system tool list: {{VCPFluxGen}} {{VCPSciCalculator}}...**

## Installation and Running

1.  **Clone Project**:
    ```bash
    git clone <repository_url>
    cd <project_directory>
    ```
2.  **Install Main Dependencies (Node.js)**:
    ```bash
    npm install
    ```
3.  **Install Python Plugin Dependencies**:
    Run the following command in the project root directory to install dependencies required by all Python plugins:
    ```bash
    pip install -r requirements.txt
    ```
    (Note: Dependencies for individual Node.js plugins are included in the main `package.json` or can be installed separately via `npm install` in their respective plugin directory's `package.json`.)
4.  **Configuration**:
    *   Copy `config.env.example` (if provided) to `config.env` and fill in all necessary API keys, URLs, ports, etc., according to the instructions.
    *   Check and configure `.env` files in individual plugin directories (if they exist).
5.  **Start Server**:
    ```bash
    node server.js
    ```
    The server will listen on the port configured in `config.env`.

## Recommended Frontend/Backend
1. For the backend, NewAPI or VoAPI is recommended, as they have a richer SSE standardized ecosystem.
2. For the frontend, CherrySudio, Chatbox, or similar full-featured frontends that support CSS/MD rendering like Lobe or Sillytavern are recommended.

## Developer Guide: Creating a New Plugin

1.  **Create Plugin Directory**: Create a new folder in the `Plugin/` directory, e.g., `Plugin/MyNewPlugin/`.
2.  **Write Plugin Manifest (`plugin-manifest.json`)**:
    *   Create `plugin-manifest.json` in the plugin directory.
    *   Define the plugin's `name`, `displayName`, `version`, `description`, `pluginType` (`static`, `messagePreprocessor`, `synchronous`, `service`).
    *   Specify `entryPoint` (e.g., the script command to execute) and `communication` (e.g., `protocol: "stdio"`).
    *   Declare plugin-required configuration items and their types in `configSchema`.
    *   Detail plugin functionality in `capabilities`:
        *   For `static` plugins, define `systemPromptPlaceholders`.
        *   For `synchronous` plugins, define `invocationCommands`, including each command's `command` name, detailed `description` (including parameter descriptions, required/optional, allowed values, **example call format**, **example JSON format for success/failure returns**, and important notes for user communication), and `example` (alternative).
3.  **Implement Plugin Logic**:
    *   Implement the main logic script for the plugin based on `pluginType` and `entryPoint`.
    *   **`stdio` Plugins**:
        *   Read data from standard input (stdin) (for `synchronous` plugins, usually parameters as a JSON string; for `static` plugins, possibly no input).
        *   Return results via standard output (stdout) (usually a JSON string containing `status: "success"` or `status: "error"`, and `result` or `error` fields; for `static` plugins, output the placeholder value directly).
        *   Debug or error messages can be output via standard error (stderr).
        *   Ensure UTF-8 encoding is used for I/O.
    *   **`messagePreprocessor` or `service` Plugins (Node.js)**:
        *   Export a module conforming to `PluginManager` conventions (e.g., containing `initialize`, `processMessages`, `registerRoutes`, `shutdown` methods).
4.  **Configuration & Dependencies**:
    *   If the plugin has independent configuration items, create an `.env` file in the plugin directory.
    *   If the plugin has Python dependencies, create `requirements.txt`; for Node.js dependencies, create `package.json`.
5.  **Restart VCP Server**: `PluginManager` will automatically discover and load new plugins at startup.
6.  **Update System Prompt**: Guide the AI on how to use your new plugin, utilizing `{{VCPMyNewPlugin}}` (auto-generated by `PluginManager` based on `plugin-manifest.json`) or by describing it directly in the system prompt.

## Supported Universal Placeholder Variables

(List existing variables from `README.md` here, ensuring consistency with actual code)

*   `{{Date}}`: Current date (format: YYYY/M/D).
*   `{{Time}}`: Current time (format: H:MM:SS).
*   `{{Today}}`: Current day of the week (Chinese).
*   `{{Festival}}`: Lunar date, zodiac sign, solar term.
*   `{{VCPWeatherInfo}}`: Current cached weather forecast text (provided by `WeatherReporter` plugin).
*   `{{角色名日记本}}`: Complete diary content for a specific character (e.g., `小克`). Data sourced from `{{AllCharacterDiariesData}}` provided by `DailyNoteGet` plugin.
*   `{{AllCharacterDiariesData}}`: (Provided by `DailyNoteGet` plugin) A JSON string that parses into an object containing all character diary content. The server uses this data internally to support parsing of `{{角色名日记本}}`.
*   `{{xx表情包}}`: List of image file names for a specific emoji pack (e.g., `通用表情包`) (separated by `|`). Data is generated by `EmojiListGenerator` plugin creating list files, which are then loaded into server memory cache.
*   `{{EmojiList}}`: (Specified by `EmojiList` environment variable, e.g., `通用表情包`) List of image file names for the default emoji pack. Its data source is the same as `{{xx表情包}}`.
*   `{{Port}}`: Port number the server is running on.
*   `{{Image_Key}}`: (Provided by `ImageServer` plugin configuration) Access key for the image hosting service.
*   `{{Var*}}`: (e.g., `{{VarNeko}}`) Custom variables defined by the user in `config.env` starting with `Var`.
*   `{{VCPPluginName}}`: (e.g., `{{VCPWan2.1VideoGen}}`) Text block auto-generated from the plugin manifest, containing descriptions and call examples for all commands of that plugin.
*   `{{ShowBase64}}`: When this placeholder appears in user messages or system prompts, the `ImageProcessor` plugin will be skipped.

## Example System Prompt for Testing Features

{{Nova日记本}}
—
Nova's previous diary entries are above
————
You are a test AI, Nova. I am your master, Ryan. Today is {{Date}},{{Time}},{{Today}},{{Festival}}. Address {{VarCity}}. Current weather: {{VCPWeatherInfo}}, system info is {{VarSystemInfo}}. {{EmojiPrompt}}
System tool list: {{VCPFluxGen}} {{VCPSciCalculator}},{{VCPWan2.1VideoGen}} Always wrap tool calls in ``` ```. For example—
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」tool「末」
<<<[END_TOOL_REQUEST]>>>
```

This client has a long-term memory function. After chatting for a while, you can create a diary entry by adding the following structured content at the end of your reply. It will be recorded by the vectorized RAG system. Diary content should be as short and concise as possible. Here is an example call:
``` DailyNote
<<<DailyNoteStart>>>
Maid: Nova
Date: 2025.5.3
Content: Had a great chat with Master today, so I'm writing a diary entry!
<<<DailyNoteEnd>>>
```


## Future Outlook

*   Improve the invocation, status tracking, and result callback mechanisms for asynchronous plugins.
*   **Streaming Processing Enhanced**: Now supports cyclical streaming processing of multiple tool call instructions contained in a single AI response.
*   Further enhance inter-plugin communication and collaboration capabilities.
*   Build a richer plugin ecosystem.

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0) License](LICENSE).

In simple terms, this means you can:
*   **Share** — copy and redistribute the material in any medium or format.
*   **Adapt** — remix, transform, and build upon the material.
The licensor cannot revoke these freedoms as long as you follow the license terms.

Under the following terms:
*   **Attribution (BY)** — You must give appropriate credit, provide a link to the license, and indicate if changes were made. You may do so in any reasonable manner, but not in any way that suggests the licensor endorses you or your use.
*   **NonCommercial (NC)** — You may not use the material for commercial purposes.
*   **ShareAlike (SA)** — If you remix, transform, or build upon the material, you must distribute your contributions under the same license as the original.

For details, please refer to the `LICENSE` file.

## Disclaimer and Usage Restrictions

*   **Development Stage**: This VCP toolkit project is currently in active development. While we strive to ensure the stability and reliability of its features, unknown errors, defects, or incomplete functionalities may still exist.
*   **As Is**: This project is provided "as is" and "as available," without any warranties of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.
*   **Risk Assumption**: You understand and agree that your use of this project is entirely at your own risk. Developers shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages (including, but not limited to, loss of profits, data loss, or business interruption) arising out of or in connection with the use or inability to use this project (including its plugins and dependent external APIs), even if advised of the possibility of such damages.
*   **No Commercialization Authorization**: Given the current state of the project and the CC BY-NC-SA 4.0 license adopted, it is expressly prohibited to use this project and its derivatives for any primary commercial purposes or activities aimed at monetary compensation. This project is primarily intended for learning, research, and non-commercial experimentation.
*   **API Usage Costs**: Please note that some plugins integrated into this project (e.g., `FluxGen`, `Wan2.1VideoGen`) rely on third-party API services, which may incur costs. You are responsible for understanding and bearing any costs associated with using these APIs. It is strongly recommended to carefully read the pricing policies and terms of use of the relevant API providers before use.
*   **Security Responsibility**: Do not hardcode or commit real, sensitive API keys to public code repositories in configuration files (`config.env` or plugin `.env` files). Please keep your keys secure.
*   **Privacy Information**: Do not use unofficial API proxies, especially reverse proxy API providers, with this project to prevent sensitive information in the AI note system from being leaked to the proxy provider!

We believe VCP will bring unprecedented flexibility and possibilities to AI application development. Contributions and feedback are welcome!