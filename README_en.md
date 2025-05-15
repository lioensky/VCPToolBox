[English](README_en.md) | [日本語](README_ja.md) | [Русский](README_ru.md)

---
# VCP (Variable & Command Protocol) - AI Capability Enhancement Middleware Toolbox

## Project Vision

VCP aims to build a middleware layer that transcends traditional AI interaction modes. It is a highly compatible, general-purpose, and extensible toolbox dedicated to empowering AI models to seamlessly interact with external APIs, services, and custom logic. Our goal is to create a powerful VCP (Variable & Command Protocol) system applicable to almost all API ports and clients, greatly expanding the boundaries of AI applications.

### *Warning: Do not use unofficial APIs (e.g., reverse proxy intermediaries) to call this toolbox to avoid irreparable information leakage.*

## Core Features

*   **Powerful Plugin Architecture**: Easily integrate and manage various functional modules through well-defined plugin manifests (`plugin-manifest.json`) and a core plugin manager (`Plugin.js`).
*   **VCP Protocol**: AI calls plugins by embedding instructions in a specific format in its replies (`<<<[TOOL_REQUEST]>>> ... <<<[END_TOOL_REQUEST]>>>`). Parameters use the `key:「始」value「末」` format, supporting complex data types and multi-line text.
*   **Support for Multiple Plugin Types**:
    *   **Static Plugins (`static`)**: Provide dynamic information (like weather, custom data) to replace placeholders in the system prompt, supporting timed refresh.
    *   **Message Preprocessor Plugins (`messagePreprocessor`)**: Modify or enhance message content before sending user requests to the AI model (e.g., image recognition and description).
    *   **Synchronous Plugins (`synchronous`)**: AI can call these plugins during a conversation to perform specific tasks (e.g., scientific calculation, image generation, video generation). The server waits for the plugin to complete execution and feeds the result (which must follow a specific JSON format) back to the AI for further processing.
    *   **Service Plugins (`service`)**: Allow plugins to register independent HTTP routes with the main application, providing additional service interfaces (e.g., image hosting service).
*   **Flexible Configuration Management**: Supports a global configuration file (`config.env`) and plugin-specific `.env` files, enabling hierarchical and isolated configuration.
*   **Universal Variable Replacement**: Automatically replaces predefined placeholder variables at various stages of interaction with the AI (system prompt, user messages).
*   **Built-in Utility Functions (Partially Plugin-ized)**:
    *   **Diary/Memory System**: Regularly reads diary content via `DailyNoteGet` (static plugin) and stores AI-generated structured diaries via `DailyNoteWrite` (synchronous plugin). Relevant content is injected into the prompt via the `{{角色名日记本}}` placeholder, with its data source provided by the `DailyNoteGet` plugin to the server's internal use via the `{{AllCharacterDiariesData}}` placeholder.
    *   **Dynamic Emoji System**: `EmojiListGenerator` (static plugin) scans the `image/` directory and generates `.txt` list files within its plugin directory. The server executes this plugin on startup and loads these lists into memory cache for use by the `{{xx表情包}}` and `{{EmojiList}}` placeholders.
    *   **Prompt Transformation**: Supports rule-based system prompt and global context text replacement.
*   **Tool Calling Loop**:
    *   **Non-streaming Mode**: Implemented loop processing and result feedback for **multiple** tool call instructions contained in a single AI response, until no more tool calls or the maximum loop count is reached.
    *   **Streaming Mode (SSE)**: Implemented loop processing and result feedback for **multiple** tool call instructions contained in a single AI response. The AI's reply and the results of VCP tool calls (if the `SHOW_VCP_OUTPUT` environment variable is set to `true`) will be streamed incrementally to the client until no more tool calls or the maximum loop count is reached.
*   **Web Management Panel**: Provides a built-in web interface for conveniently managing server configuration, plugin status, plugin configuration, command descriptions, and diary files.
*   **Debugging and Logging**: Provides debug mode and detailed logging for easy development and troubleshooting.

## System Architecture Overview

1.  **Client Request**: The client sends a request to the VCP server's `/v1/chat/completions` endpoint.
2.  **`server.js` (Core Server)**:
    *   Receives the request and performs initial processing (e.g., authentication, variable replacement).
    *   Calls `messagePreprocessor` plugins (like `ImageProcessor`) to process user messages.
    *   Forwards the processed request to the backend AI model.
3.  **AI Model Response**: The AI model returns a response.
4.  **`server.js` Processes AI Response and Executes Tool Loop**:
    *   Detects if the AI response contains VCP tool call instructions (`<<<[TOOL_REQUEST]>>>`).
    *   **If tool calls are included**:
        *   Parses the instructions, extracting tool names and parameters.
        *   **Execute Tools in a Loop**: For each parsed tool call, calls the `PluginManager` to execute the corresponding `synchronous` plugin.
        *   **Process Plugin Results**: The `PluginManager` executes the plugin and receives its output in JSON format.
        *   **Secondary AI Call**: Formats the execution results of all tools and adds them as a new user message to the conversation history. Calls the backend AI model again, sending the complete conversation history including the plugin results.
        *   Repeats step 4 until the AI response no longer contains tool call instructions or the maximum loop count is reached.
    *   **If the AI response does not contain tool calls**:
        *   If `SHOW_VCP_OUTPUT` is enabled, returns the tool execution process and results (if they occurred) along with the AI's final reply to the client.
        *   Streams or non-streams the AI's final response to the client.
    *   **Diary Processing**: If the AI response contains a structured diary block (`<<<DailyNoteStart>>>...<<<DailyNoteEnd>>>`), parses the content and calls the `DailyNoteWrite` plugin for storage.
5.  **`Plugin.js` (Plugin Manager)**:
    *   Loads the plugin manifest on server startup, initializing `static` and `service` plugins.
    *   Finds loaded plugins based on the tool name.
    *   Prepares the execution environment and configuration for plugins (including merging global and plugin-specific configurations).
    *   Interacts with plugin scripts via `stdio` (or other protocols), sending input (e.g., JSON parameters) and receiving output (which must follow the `{status, result/error}` JSON format).
    *   Returns the plugin's execution result to `server.js`.
6.  **Static and Service Plugins**:
    *   `static` plugins are called by the `PluginManager` on server startup and/or via scheduled tasks to update placeholder variables (e.g., `{{VCPWeatherInfo}}`, `{{AllCharacterDiariesData}}`, `{{xx表情包}}` list data).
    *   `service` plugins (like `ImageServer`) are initialized by the `PluginManager` on server startup and register their own routes (`/pw=.../images/`, etc.) with the Express application.
7.  **Web Management Panel**: Interacts with the backend defined by `/admin_api` endpoint and `routes/adminPanelRoutes.js` to provide configuration, plugin, and diary management functions.

## Web Management Panel

To facilitate user management of server configuration, plugins, and diary data, the project includes a feature-rich built-in Web management panel.

**Main Features**:

*   **Main Configuration Management**:
    *   Online preview and editing of the `config.env` file content in the project root directory.
    *   Supports editing configuration items of different types such as boolean, integer, and multi-line strings.
    *   **Note**: For security reasons, the management interface automatically hides the `AdminUsername` and `AdminPassword` fields when displaying the main configuration. When saving, the system merges your modified content with the original sensitive field values on the server to ensure credentials are not lost.
    *   **Important**: After saving changes to `config.env`, **you usually need to manually restart the server** for all changes (such as port, API keys, plugin-specific configurations, etc.) to take full effect. The server does not currently restart automatically.
*   **Plugin Management**:
    *   **List and Status**: Displays all discovered plugins in the `Plugin/` directory, their enabled/disabled status, version, and description.
    *   **Description Editing**: Edit the main description information in each plugin's `plugin-manifest.json` file directly in the interface.
    *   **Enable/Disable Plugins**: Toggle the enabled status of plugins via interface switches (implemented by renaming the plugin's `plugin-manifest.json` to `plugin-manifest.json.block` or vice versa).
    *   **Plugin Configuration**: Read and edit the `config.env` file (if it exists) in each plugin directory. Supports editing configuration items defined in the `configSchema` in the plugin manifest, as well as custom configuration items.
    *   **Command Description Editing**: For synchronous plugins with `invocationCommands` capability, you can directly edit the AI command description for each command in the interface. These descriptions are used by the `PluginManager` to generate the `{{VCPPluginName}}` placeholder content.
*   **Diary Management**:
    *   Browse all character folders in the `dailynote/` directory.
    *   View the list of diary files in each folder, including file name and modification time, and display a partial content preview.
    *   Supports searching diary content by keywords, searchable in all folders or specified folders.
    *   Online editing and saving of diary file content.
    *   Batch move selected diaries to other folders.
    *   Batch delete selected diary files.
*   **Server Restart**: Provides a button to send a server restart command (depends on an external process manager like PM2).

**Access and Login**:

1.  **Set Credentials**: Before first use, ensure you have set the following two variables in the `config.env` file in the project root directory:
    ```env
    AdminUsername=your_admin_username
    AdminPassword=your_admin_password
    ```
    **Important**: If `AdminUsername` or `AdminPassword` are not set, the management panel and its `/admin_api` endpoint will be inaccessible and will return a 503 Service Unavailable error. These credentials must be configured to enable the management panel. Default account is admin, password is 123456.
2.  **Access Address**: After starting the server, access `http://<Your Server IP or Domain>:<Port>/AdminPanel` through a browser.
3.  **Login**: The browser will pop up an HTTP Basic Auth authentication window. Please enter the `AdminUsername` and `AdminPassword` you set in `config.env` to log in. Default account is admin, password is 123456.

## Implemented Plugin Examples

*   **`WeatherReporter` (`static`)**: Gets and caches weather information for use by the `{{VCPWeatherInfo}}` variable.
*   **`ImageProcessor` (`messagePreprocessor`)**: Automatically transcribes Base64 images in user messages into text descriptions and caches them.
*   **`SciCalculator` (`synchronous`)**: Provides scientific calculation capabilities, supporting mathematical functions, statistics, and calculus.
*   **`ImageServer` (`service`)**: Provides a static image hosting service with key authentication.
*   **`FluxGen` (`synchronous`)**: Integrates SiliconFlow API to implement text-to-image functionality and saves images to the local server.
*   **`Wan2.1VideoGen` (`synchronous`)**: Integrates SiliconFlow Wan2.1 API to implement text-to-video and image-to-video functionality.
*   **`SunoGen` (`synchronous`)**: Integrates Suno API to generate original songs, supporting custom lyrics/styles, inspiration descriptions, or continuation mode.
*   **`TavilySearch` (`synchronous`)**: Integrates Tavily API to provide web search capabilities.
*   **`DailyNoteGet` (`static`)**: Regularly reads diaries of all characters in the `dailynote/` directory and provides them via the `{{AllCharacterDiariesData}}` placeholder to the server to support the parsing of `{{角色名日记本}}`.
*   **`DailyNoteWrite` (`synchronous`)**: Receives diary data containing [tags], character name, date, and content (via stdin), and writes it to the corresponding diary file.
*   **`EmojiListGenerator` (`static`)**: Scans emoji folders in the project's `image/` directory and generates corresponding `.txt` list files in the plugin's own `generated_lists/` directory for the server to load and use.
*   **`DailyNoteManager` (`synchronous`)**: Powerful knowledge base organizing assistant, fully automatic organization, maintenance, and checking of the knowledge base within the server, safeguarding your VCP's infinite permanent memory. AI automatically and quickly establishes a public knowledge base.

## How to Load Plugins

*   **Simply define the following fields in the system prompt, e.g., System Tool List: {{VCPFluxGen}} {{VCPSciCalculator}}...**

## Installation and Running

1.  **Clone the Project**:
    ```bash
    git clone https://github.com/lioensky/VCPToolBox.git
    cd VCPToolBox
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
    (Note: Dependencies for individual Node.js plugins are either included in the main `package.json` or installed separately via `npm install` in their respective plugin directories.)
4.  **Configuration**:
    *   Copy `config.env.example` (if provided) to `config.env` and fill in all necessary API keys, URLs, ports, etc., according to the instructions.
    *   Check and configure the `.env` file (if it exists) in each plugin directory.
5.  **Start the Server**:
    ```bash
    node server.js
    ```
    The server will listen on the port configured in `config.env`.

### Running with Docker Compose (Recommended)

You can also use Docker Compose to simplify project deployment and management.

1.  **Prerequisites**:
    *   Ensure you have [Docker](https://docs.docker.com/get-docker/) installed.
    *   Ensure you have [Docker Compose](https://docs.docker.com/compose/install/) installed.

2.  **Configuration**:
    *   Copy `config.env.example` to `config.env` and fill in all necessary API keys, URLs, ports, etc., according to the instructions. Docker Compose will automatically load environment variables from this file.

3.  **Build and Start Services**:
    In the project root directory, run the following command:
    ```bash
    docker-compose up --build -d
    ```
    This command will:
    *   Build the Docker image (if not already built or if the Dockerfile has changed).
    *   Start the service containers in the background.
    *   The service will listen on the port defined by the `PORT` variable in `config.env` (default is `6005`).

4.  **View Logs**:
    ```bash
    docker-compose logs -f
    ```

5.  **Stop Services**:
    ```bash
    docker-compose down
    ```
## Recommended Frontend/Backend

1.  For the backend, NewAPI or VoAPI are recommended as they have a rich SSE standardization ecosystem.
2.  For the frontend, CherrySudio, Chatbox, or full-featured frontends like Lobe or Sillytavern that support CSS/MD rendering are recommended.

## Developer Guide: Creating a New Plugin

1.  **Create Plugin Directory**: Create a new folder in the `Plugin/` directory, for example, `Plugin/MyNewPlugin/`.
2.  **Write Plugin Manifest (`plugin-manifest.json`)**:
    *   Create `plugin-manifest.json` in the plugin directory.
    *   Define the plugin's `name`, `displayName`, `version`, `description`, and `pluginType` (`static`, `messagePreprocessor`, `synchronous`, `service`).
    *   Specify the `entryPoint` (e.g., the script command to execute) and `communication` (like `protocol: "stdio"`).
    *   Declare the configuration items required by the plugin and their types in `configSchema`. These configuration items will be passed to the plugin via the `_getPluginConfig` method after merging global and plugin-specific `.env` configurations.
    *   Detail plugin capabilities in `capabilities`:
        *   For `static` plugins, define `systemPromptPlaceholders`.
        *   For `synchronous` plugins, define `invocationCommands`. These commands require a `command` name (for internal identification) and a detailed `description` (used to generate AI command descriptions, editable in the management panel). The `description` should include parameter descriptions, required/optional status, allowed values, **invocation format examples**, **JSON format examples for successful/failed returns**, and important tips for communicating with the user. Optionally provide an `example`.
3.  **Implement Plugin Logic**:
    *   Implement the main logic script for the plugin based on `pluginType` and `entryPoint`.
    *   **`stdio` Plugins**:
        *   Read data from standard input (stdin) (for `synchronous` plugins, typically JSON strings of parameters; for `static` plugins, possibly no input).
        *   **Return results via standard output (stdout), which must follow the following JSON format**:
            ```json
            {
              "status": "success" | "error",
              "result": "String content returned on success", // Only exists when status is "success"
              "error": "String error message returned on failure" // Only exists when status is "error"
            }
            ```
            For `static` plugins, if they are only used to update placeholders, they can directly output the placeholder value (non-JSON). However, if more complex communication or error reporting is needed, it is recommended to also follow the above JSON format.
        *   Debug or error information can be output via standard error (stderr).
        *   Ensure UTF-8 encoding is used for I/O.
    *   **`messagePreprocessor` or `service` Plugins (Node.js)**:
        *   Export a module that conforms to the `PluginManager`'s conventions (e.g., includes `initialize`, `processMessages`, `registerRoutes`, `shutdown` methods).
4.  **Configuration and Dependencies**:
    *   If the plugin has independent configuration items, you can create a `.env` file (`pluginSpecificEnvConfig`) in the plugin directory. These configurations will override same-named configurations in the global `config.env`.
    *   If the plugin has Python dependencies, create `requirements.txt`; if it has Node.js dependencies, create `package.json`.
    *   **Important**: Ensure the plugin's dependencies are installed. For Python plugins, run `pip install -r requirements.txt`; for Node.js plugins, run `npm install` in its directory or in the project root directory (if dependencies are included in the main `package.json`).
5.  **Restart VCP Server**: The `PluginManager` will automatically discover and load new plugins on startup.
6.  **Update System Prompt**: Instruct the AI on how to use your new plugin, using `{{VCPMyNewPlugin}}` (automatically generated by `PluginManager` based on `plugin-manifest.json` and command descriptions) or by describing it directly in the system prompt.

## Supported Universal Variable Placeholders

(The list of variables already in `README.md` can be listed here, ensuring consistency with the actual code)

*   `{{Date}}`: Current date (Format: YYYY/M/D).
*   `{{Time}}`: Current time (Format: H:MM:SS).
*   `{{Today}}`: Day of the week (in Chinese).
*   `{{Festival}}`: Lunar date, zodiac sign, solar term.
*   `{{VCPWeatherInfo}}`: Current cached weather forecast text (provided by the `WeatherReporter` plugin).
*   `{{角色名日记本}}`: Full diary content for a specific character (e.g., `小克`). Data comes from `{{AllCharacterDiariesData}}` provided by the `DailyNoteGet` plugin.
*   `{{公共日记本}}`: Full diary content of the shared knowledge base. Data comes from `{{AllCharacterDiariesData}}` provided by the `DailyNoteGet` plugin.
*   `{{AllCharacterDiariesData}}`: (Provided by the `DailyNoteGet` plugin) A JSON string that, when parsed, is an object containing the diary content of all characters. The server uses this data internally to support the parsing of `{{角色名日记本}}`.
*   `{{xx表情包}}`: List of image filenames for a specific emoji pack (e.g., `通用表情包`) separated by `|`. Data is generated by the `EmojiListGenerator` plugin into list files, which the server loads into memory cache for use.
*   `{{EmojiList}}`: (Specified by the environment variable `EmojiList`, e.g., `通用表情包`) List of image filenames for the default emoji pack. Its data source is the same as `{{xx表情包}}`.
*   `{{Port}}`: The port number the server is running on.
*   `{{Image_Key}}`: (Provided by the `ImageServer` plugin configuration) Access key for the image hosting service.
*   `{{Var*}}`: (e.g., `{{VarNeko}}`) Custom variables defined by the user in `config.env` that start with `Var`.
*   `{{VCPPluginName}}`: (e.g., `{{VCPWan2.1VideoGen}}`) A text block automatically generated from the plugin manifest that includes descriptions and invocation examples for all commands of that plugin.
*   `{{ShowBase64}}`: When this placeholder appears in a user message or system prompt, the `ImageProcessor` plugin will be skipped.

## System Prompt Examples for Testing Features

{{Nova日记本}}
—
Previous diary of Nova is above
————
You are a test AI, Nova. I am your master, Ryan. Today is {{Date}}, {{Time}}, {{Today}}, {{Festival}}. Address {{VarCity}}. Current weather: {{VCPWeatherInfo}}, system info is {{VarSystemInfo}}. {{EmojiPrompt}}
System Tool List: {{VCPFluxGen}} {{VCPSciCalculator}}, {{VCPWan2.1VideoGen}} always wrap tool calls in ``` ```. For example—
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」tool「末」
<<<[END_TOOL_REQUEST]>>>
```

This client is equipped with long-term memory function. After chatting for a while, you can create a diary by adding the following structured content at the end of your reply. It will be recorded by the vectorized RAG system. The diary content should be as brief and concise as possible. Here is an example call:
``` DailyNote
<<<DailyNoteStart>>>
Maid: Nova  //Using '[公共]Nova' as the signature will expose the diary to all agents, or you can use a custom [tag]
Date: 2025.5.3
Content:Chatting with master today was super fun, so I'm writing a diary!
<<<DailyNoteEnd>>>
```

## Future Outlook

*   Improve the invocation, status tracking, and result callback mechanisms for asynchronous plugins.
*   **Streaming capability enhanced**: Now supports looped streaming processing of multiple tool call instructions contained in a single AI response.
*   Further enhance communication and collaboration capabilities between plugins.
*   Build a richer plugin ecosystem.

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0) License](LICENSE).

In simple terms, this means you are free to:
*   **Share** — copy and redistribute the material in any medium or format.
*   **Adapt** — remix, transform, and build upon the material.
As long as you follow the license terms, the licensor cannot revoke these freedoms.

Under the following terms:
*   **Attribution (BY)** — You must give appropriate credit, provide a link to the license, and indicate if changes were made. You may do so in any reasonable manner, but not in any way that suggests the licensor endorses you or your use.
*   **NonCommercial (NC)** — You may not use the material for commercial purposes.
*   **ShareAlike (SA)** — If you remix, transform, or build upon the material, you must distribute your contributions under the same license as the original.

See the `LICENSE` file for full details.

## Disclaimer and Usage Restrictions

*   **Development Stage**: This VCP toolbox project is currently in an active development phase. While we strive to ensure the stability and reliability of its functions, unknown errors, bugs, or incomplete features may still exist.
*   **Provided As Is**: This project is provided "as is" and "as available" without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement.
*   **Use at Your Own Risk**: You understand and agree that the use of this project is entirely at your own risk. The developers shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages (including but not limited to loss of profits, data loss, or business interruption) arising from the use of or inability to use this project (including its plugins and dependent external APIs), even if advised of the possibility of such damages.
*   **No Commercial Authorization**: Given the current status of the project and the adopted CC BY-NC-SA 4.0 license, any major commercial use or activities for monetary gain of this project and its derivative works are explicitly prohibited. This project is primarily intended for learning, research, and non-commercial experimentation.
*   **API Usage Costs**: Please note that some plugins integrated into this project (such as `FluxGen`, `Wan2.1VideoGen`) rely on third-party API services, which may incur costs. You are responsible for understanding and bearing any costs incurred from using these APIs. It is strongly recommended to carefully read the pricing strategies and terms of use of the relevant API providers before use.
*   **Security Responsibility**: Do not hardcode or commit real, sensitive API keys in configuration files (`config.env` or plugin `.env` files) to public code repositories. Please keep your keys secure.
*   **Privacy Information**: Do not use unofficial API proxies, especially reverse proxy API providers, with this project to avoid sensitive information in the AI note system being leaked to the proxy provider!

We believe that VCP will bring unprecedented flexibility and possibilities to the development of AI applications. Contributions and feedback are welcome!