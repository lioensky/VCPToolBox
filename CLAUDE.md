# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VCP (Variable & Command Protocol) ToolBox is an advanced AI capability enhancement middleware layer that enables AI agents to extend their capabilities through a powerful plugin ecosystem. It acts as a universal bridge between AI models and external tools, supporting multiple plugin types including synchronous, asynchronous, static, message preprocessors, and service plugins.

## Development Environment

### Technology Stack
- **Backend**: Node.js with Express.js
- **Plugin System**: Multi-language support (Node.js, Python, Shell scripts)
- **Communication**: WebSocket for real-time messaging, HTTP for API calls
- **Containerization**: Docker with multi-stage builds
- **Process Management**: PM2 for production deployment

### Key Dependencies
- Core: express, ws, dotenv, node-schedule, puppeteer
- AI Integration: Support for multiple AI model APIs (OpenAI, Gemini, etc.)
- Plugin Dependencies: Various based on plugin requirements (see individual plugin directories)

## Common Development Commands

### Server Management
```bash
# Start development server
node server.js

# Install dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt

# Docker operations
docker-compose up --build -d
docker-compose logs -f
docker-compose down
```

### PM2 Management (Production)
```bash
# Start with PM2
npm run start:pm2

# Restart server
npm run restart:pm2

# Stop server
npm run stop:pm2
```

### Testing
```bash
# Run tests (currently minimal test setup)
npm test
```

## Architecture Overview

### Core Components

1. **server.js**: Main Express server handling API routes and AI model communication
2. **Plugin.js**: Central plugin management system handling plugin discovery, execution, and lifecycle
3. **WebSocketServer.js**: Unified WebSocket service for real-time communication with clients and distributed nodes
4. **routes/**: Specialized routing modules for admin panel, task scheduling, and model-specific handling

### Plugin System Architecture

VCP supports multiple plugin types, each serving different purposes:

- **Synchronous Plugins**: Blocking execution, immediate results (e.g., SciCalculator)
- **Asynchronous Plugins**: Non-blocking, callback-based results (e.g., VideoGenerator)
- **Static Plugins**: Provide dynamic data via placeholders (e.g., WeatherReporter)
- **Message Preprocessors**: Modify user messages before AI processing (e.g., ImageProcessor)
- **Service Plugins**: Register HTTP routes for additional services (e.g., ImageServer)
- **Hybrid Service Plugins**: Combine preprocessing and service capabilities (e.g., VCPTavern)

### Distributed Architecture

The system supports distributed nodes for scaling compute resources:
- Main server coordinates with distributed nodes via WebSocket
- Plugins can run on remote machines with transparent execution
- File sharing across nodes through internal WebSocket protocol

### Configuration System

Multi-layered configuration approach:
- **config.env**: Main server configuration
- **Plugin-specific .env files**: Individual plugin settings
- **Variable substitution system**: Dynamic placeholder injection ({{Var*}}, {{Tar*}}, {{Sar*}})

## Key Development Patterns

### Plugin Development
1. Create plugin directory under `Plugin/`
2. Define `plugin-manifest.json` with capabilities and configuration schema
3. Implement plugin logic (Python/Node.js/Shell)
4. Configure plugin-specific settings in `.env` file
5. Plugin automatically discovered and loaded on server restart

### Variable Placeholder System
- **{{Tar*}}**: Highest priority, supports nested placeholders
- **{{Var*}}**: Global text replacement variables
- **{{Sar*}}**: Model-specific conditional variables
- **{{VCP*}}**: System-provided plugin descriptions and data

### Tool Call Protocol
AI agents use VCP's custom protocol format:
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」PluginName「末」,
param1:「始」value1「末」,
param2:「始」value2「末」
<<<[END_TOOL_REQUEST]>>>
```

## File Structure Conventions

```
Plugin/
├── PluginName/
│   ├── plugin-manifest.json    # Plugin definition
│   ├── config.env             # Plugin configuration
│   ├── main.py/js             # Plugin implementation
│   ├── requirements.txt       # Python dependencies
│   └── package.json          # Node.js dependencies
Agent/                        # AI agent personality files
dailynote/                    # Persistent memory storage
TVStxt/                       # Advanced variable definitions
image/                        # Generated media storage
file/                         # File service directory
AdminPanel/                   # Web management interface
```

## Configuration Management

### Environment Variables
Key configuration variables in `config.env`:
- `API_Key`, `API_URL`: Backend AI service credentials
- `PORT`, `Key`: Server access configuration
- `DebugMode`, `ShowVCP`: Development settings
- Agent definitions via `Agent*` variables
- Tool list configuration via `VarToolList`

### Plugin Configuration
Each plugin can define its own configuration schema in `plugin-manifest.json`:
- Required parameters with types and defaults
- API keys and external service settings
- Behavior toggles and limits

## Important Notes

- **Security**: Never commit API keys or sensitive configuration
- **Plugin Isolation**: Plugins run in separate processes for security
- **Memory Management**: System includes persistent memory through daily notes
- **Real-time Communication**: WebSocket server handles live updates and notifications
- **Multi-language Support**: Plugins can be written in any language supporting stdio communication

## Development Workflow

1. **Setup**: Clone repository, install dependencies, configure `config.env`
2. **Plugin Development**: Create new plugins following the manifest pattern
3. **Testing**: Use development server with debug mode enabled
4. **Deployment**: Use Docker Compose for consistent deployment
5. **Monitoring**: Access AdminPanel for plugin management and system monitoring

The system is designed for extensibility and supports complex AI agent workflows through its sophisticated plugin architecture and distributed computing capabilities.