const BRIDGE_VERSION = '2.1.0';
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const CANCELLED_INVOCATION_TTL_MS = 5 * 60 * 1000;
const SNOW_REQUEST_HEADER_KEYS = [
	'x-snow-client',
	'x-snow-protocol',
	'x-snow-tool-mode',
	'x-snow-channel',
];
const SNOW_SOURCE_CONTRACT = Object.freeze({
	'x-snow-client': ['snow-cli'],
	'x-snow-protocol': ['function-calling'],
	'x-snow-channel': ['bridge-ws'],
});

function splitCsv(value) {
	return String(value || '')
		.split(',')
		.map(item => item.trim())
		.filter(Boolean);
}

function buildError(code, message, extra = {}) {
	const details =
		extra.details && typeof extra.details === 'object' ? extra.details : undefined;

	return {
		code,
		message,
		retryable: extra.retryable === true,
		source: extra.source || 'snowbridge',
		...(details ? {details} : {}),
		...Object.fromEntries(
			Object.entries(extra).filter(([key]) =>
				!['details', 'retryable', 'source'].includes(key),
			),
		),
	};
}

function normalizeToolIdSegment(value) {
	return (
		String(value || '')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'tool'
	);
}

function buildBridgeToolId(originName) {
	return [
		normalizeToolIdSegment('vcp_bridge'),
		normalizeToolIdSegment('snowbridge'),
		normalizeToolIdSegment(originName),
	].join(':');
}

function uniqueStrings(values) {
	return Array.from(
		new Set(
			values
				.map(value => String(value || '').trim())
				.filter(Boolean),
		),
	);
}

function normalizeCommandName(command) {
	if (!command || typeof command !== 'object') {
		return null;
	}

	return command.commandIdentifier || command.command || null;
}

function normalizeInvocationCommand(command) {
	const commandName = normalizeCommandName(command);
	if (!commandName) {
		return null;
	}

	return {
		commandName,
		description: normalizeBridgeText(command.description || ''),
		parameters: Array.isArray(command.parameters) ? command.parameters : [],
		example: normalizeBridgeText(command.example || ''),
	};
}

function parseToolError(error) {
	if (!error) {
		return buildError('bridge_unknown_error', 'Unknown bridge error.');
	}

	if (typeof error === 'string') {
		return buildError('bridge_error', error);
	}

	if (error.message) {
		try {
			const parsed = JSON.parse(error.message);
			if (parsed.plugin_error || parsed.plugin_execution_error) {
				return buildError(
					'plugin_execution_error',
					parsed.plugin_error || parsed.plugin_execution_error,
					{
						source: 'plugin',
						details: parsed,
					},
				);
			}
		} catch {}

		return buildError('bridge_error', error.message, {
			source: 'snowbridge',
		});
	}

	if (typeof error === 'object' && error.code) {
		return buildError(error.code, error.message || String(error), {
			retryable: error.retryable === true,
			source: error.source || 'snowbridge',
			details:
				error.details && typeof error.details === 'object'
					? error.details
					: undefined,
		});
	}

	return buildError('bridge_error', String(error));
}

function buildCapabilityTags(bridgeCommands, bridgeCapabilities) {
	const tags = ['bridge_transport'];

	tags.push((bridgeCommands || []).length > 1 ? 'multi_command' : 'single_command');

	if (bridgeCapabilities.cancelVcpTool) {
		tags.push('cancellable');
	}

	if (bridgeCapabilities.asyncCallbacks) {
		tags.push('async_callback');
	}

	if (bridgeCapabilities.statusEvents) {
		tags.push('status_events');
	}

	if (bridgeCapabilities.clientAuth) {
		tags.push('client_auth');
	}

	return uniqueStrings(tags);
}

function normalizeBridgeText(description) {
	return String(description || '')
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map(line => line.trimEnd())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function buildAsyncStatusPayload(context, options = {}) {
	const taskId = String(options.taskId || context.taskId || '').trim() || undefined;
	const state = options.state || 'running';
	const event = options.event || 'lifecycle';
	const status = options.status || state;

	return {
		requestId: context.requestId,
		invocationId: context.invocationId,
		toolId: context.toolId,
		toolName: context.publicName || context.toolName,
		originName: context.toolName,
		status,
		async: true,
		...(taskId ? {taskId} : {}),
		asyncStatus: {
			enabled: true,
			state,
			event,
			...(taskId ? {taskId} : {}),
		},
		...(options.result !== undefined ? {result: options.result} : {}),
		...(options.error ? {error: options.error} : {}),
		...(options.extra || {}),
	};
}

function buildToolResultPayload(context, options = {}) {
	const taskId = String(options.taskId || context.taskId || '').trim() || undefined;
	const error = options.error;
	const nextStatus = options.status || (error ? 'error' : 'success');

	return {
		requestId: context.requestId,
		invocationId: context.invocationId,
		toolId: context.toolId,
		toolName: context.publicName || context.toolName,
		originName: context.toolName,
		status: nextStatus,
		...(taskId ? {taskId} : {}),
		asyncStatus: {
			enabled: Boolean(taskId),
			state: nextStatus === 'error' ? 'error' : 'completed',
			event: 'result',
			...(taskId ? {taskId} : {}),
		},
		...(options.result !== undefined ? {result: options.result} : {}),
		...(error ? {error} : {}),
	};
}

function normalizeHeaderValue(value) {
	return String(value || '').trim();
}

function normalizeHeaderMap(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => typeof key === 'string')
			.map(([key, headerValue]) => [
				key.trim().toLowerCase(),
				normalizeHeaderValue(headerValue),
			])
			.filter(([, headerValue]) => Boolean(headerValue)),
	);
}

class SnowBridge {
	constructor() {
		this.pluginManager = null;
		this.wss = null;
		this.config = {};
		this.debugMode = false;
		this.isHooked = false;
		this.eventSubscriptions = [];
		this.patchState = null;
		this.activeInvocations = new Map(); // invocationId -> context
		this.taskToInvocationMap = new Map(); // taskId -> invocationId
		this.rateLimitState = new Map(); // clientKey -> { windowStart, count }
	}

	async initialize(config, dependencies) {
		this.config = config;
		this.debugMode = config.DebugMode === true;
		this.log = dependencies.vcpLogFunctions || {
			pushVcpLog: () => {},
			pushVcpInfo: () => {},
		};

		try {
			this.bindPluginManager(require('../../Plugin.js'));
			this.setupEventListeners();
		} catch (error) {
			console.error(
				'[SnowBridge] Failed to load PluginManager for event listening:',
				error.message,
			);
		}

		if (this.debugMode) {
			console.log('[SnowBridge] Initialized with event listeners.');
		}
	}

	bindPluginManager(pluginManager) {
		if (this.pluginManager === pluginManager) {
			return;
		}

		this.removeEventListeners();
		this.pluginManager = pluginManager;
	}

	setupEventListeners() {
		if (!this.pluginManager) {
			return;
		}

		this.removeEventListeners();

		const forwardLog = (bridgeType, data) => {
			if (this.config.Bridge_Enabled === false) {
				return;
			}

			const taskId = String(data.job_id || data.taskId || '');
			if (!taskId) {
				return;
			}

			const invocationId = this.taskToInvocationMap.get(taskId);
			const context = invocationId
				? this.activeInvocations.get(invocationId)
				: null;

			if (!context || context.cancelled) {
				return;
			}

			if (this.debugMode) {
				console.log(
					`[SnowBridge] Forwarding ${bridgeType} for task ${taskId} to ${context.serverId}`,
				);
			}

			this.sendToServer(context.serverId, {
				type: 'vcp_tool_status',
				data: {
					...data,
					...buildAsyncStatusPayload(context, {
						taskId,
						state: 'running',
						status: 'running',
						event: bridgeType === 'log' ? 'log' : 'info',
						extra: {bridgeType},
					}),
				},
			});
		};

		const logListener = data => forwardLog('log', data);
		const infoListener = data => forwardLog('info', data);
		const asyncCallbackListener = info => {
			if (this.config.Bridge_Enabled === false) {
				return;
			}

			const taskId = String(info.taskId || '');
			if (!taskId) {
				return;
			}

			const invocationId = this.taskToInvocationMap.get(taskId);
			const context = invocationId
				? this.activeInvocations.get(invocationId)
				: null;

			if (!context) {
				return;
			}

			if (context.cancelled) {
				this.cleanupInvocation(invocationId);
				return;
			}

			if (this.debugMode) {
				console.log(
					`[SnowBridge] Forwarding async result for task ${taskId} to ${context.serverId}`,
				);
			}

			this.sendToServer(context.serverId, {
				type: 'vcp_tool_result',
				data: buildToolResultPayload(context, {
					taskId,
					status: 'success',
					result: info.data,
				}),
			});
			this.cleanupInvocation(invocationId);
		};

		this.pluginManager.on('vcp_log', logListener);
		this.pluginManager.on('vcp_info', infoListener);
		this.pluginManager.on('plugin_async_callback', asyncCallbackListener);
		this.eventSubscriptions = [
			{eventName: 'vcp_log', listener: logListener},
			{eventName: 'vcp_info', listener: infoListener},
			{eventName: 'plugin_async_callback', listener: asyncCallbackListener},
		];
	}

	removeEventListeners() {
		if (!this.pluginManager || this.eventSubscriptions.length === 0) {
			this.eventSubscriptions = [];
			return;
		}

		for (const subscription of this.eventSubscriptions) {
			if (typeof this.pluginManager.off === 'function') {
				this.pluginManager.off(subscription.eventName, subscription.listener);
				continue;
			}

			if (typeof this.pluginManager.removeListener === 'function') {
				this.pluginManager.removeListener(
					subscription.eventName,
					subscription.listener,
				);
			}
		}

		this.eventSubscriptions = [];
	}

	registerApiRoutes(router, config, projectBasePath, wss) {
		if (this.wss && this.wss !== wss) {
			this.removeMonkeyPatch();
		}

		this.wss = wss;
		this.config = {...this.config, ...config};

		if (!this.wss) {
			console.error(
				'[SnowBridge] WebSocketServer instance is missing in registerApiRoutes.',
			);
			return;
		}

		this.applyMonkeyPatch();

		router.get('/status', (req, res) => {
			res.json({
				status: 'active',
				hooked: this.isHooked,
				bridgeEnabled: this.config.Bridge_Enabled !== false,
				bridgeVersion: BRIDGE_VERSION,
				capabilities: this.getBridgeCapabilities(),
			});
		});

		if (this.debugMode) {
			console.log(
				'[SnowBridge] API routes registered and monkey patch applied.',
			);
		}
	}

	applyMonkeyPatch() {
		if (
			this.patchState?.wss === this.wss &&
			this.patchState.wss?.handleDistributedServerMessage ===
				this.patchState.wrappedHandler
		) {
			return;
		}

		const wss = this.wss;
		let pluginManager;
		try {
			pluginManager = require('../../Plugin.js');
		} catch (error) {
			console.error(
				'[SnowBridge] Error requiring Plugin.js:',
				error.message,
			);
		}

		if (!pluginManager) {
			console.error('[SnowBridge] Could not obtain PluginManager instance.');
			return;
		}

		this.bindPluginManager(pluginManager);

		const originalHandler = wss.handleDistributedServerMessage;
		if (typeof originalHandler !== 'function') {
			console.error(
				'[SnowBridge] WebSocketServer.handleDistributedServerMessage is not a function. Hook failed.',
			);
			return;
		}

		this.removeMonkeyPatch();

		const self = this;
		const wrappedHandler = async function (serverId, message) {
			if (self.config.Bridge_Enabled === false) {
				return originalHandler.call(wss, serverId, message);
			}

			try {
				const requestData =
					message && typeof message.data === 'object' && message.data !== null
						? message.data
						: {};

				if (self.debugMode) {
					console.log(
						`[SnowBridge] Intercepted message type ${message.type} from ${serverId}`,
					);
				}

				switch (message.type) {
					case 'get_vcp_manifests':
						if (!self.isSnowBridgeRequest(requestData)) {
							break;
						}
						await self.handleGetManifests(serverId, message, pluginManager);
						return;

					case 'execute_vcp_tool':
						if (!self.isSnowBridgeRequest(requestData)) {
							break;
						}
						await self.handleExecuteTool(serverId, message, pluginManager);
						return;

					case 'cancel_vcp_tool':
						if (!self.isSnowBridgeRequest(requestData)) {
							break;
						}
						await self.handleCancelTool(serverId, message);
						return;
				}
			} catch (error) {
				console.error(
					`[SnowBridge] Error handling bridged message ${message.type}:`,
					error,
				);
			}

			return originalHandler.call(wss, serverId, message);
		};
		wrappedHandler.__snowBridgePatched = true;
		wrappedHandler.__snowBridgeOriginalHandler = originalHandler;

		wss.handleDistributedServerMessage = wrappedHandler;
		this.patchState = {
			wss,
			originalHandler,
			wrappedHandler,
		};

		this.isHooked = true;
		console.log(
			'[SnowBridge] Monkey patch successful: SnowBridge is now active.',
		);
	}

	removeMonkeyPatch() {
		if (!this.patchState) {
			this.isHooked = false;
			return;
		}

		const {wss, originalHandler, wrappedHandler} = this.patchState;
		if (wss?.handleDistributedServerMessage === wrappedHandler) {
			wss.handleDistributedServerMessage = originalHandler;
		}

		this.patchState = null;
		this.isHooked = false;
	}

	sendToServer(serverId, payload) {
		if (!this.wss) {
			return false;
		}

		return this.wss.sendMessageToClient(serverId.replace('dist-', ''), payload);
	}

	getBridgeCapabilities() {
		return {
			cancelVcpTool: true,
			toolFilters: true,
			asyncCallbacks: true,
			statusEvents: true,
			clientAuth: Boolean(this.getBridgeAccessToken()),
		};
	}

	getBridgeAccessToken() {
		return String(this.config.Bridge_Access_Token || '').trim();
	}

	getAllowedTools() {
		return new Set(splitCsv(this.config.Allowed_Tools));
	}

	getExcludedTools() {
		return new Set(splitCsv(this.config.Excluded_Tools));
	}

	getExcludedDisplayKeywords() {
		return splitCsv(this.config.Excluded_Display_Keywords).map(keyword =>
			keyword.replace(/^["']|["']$/g, ''),
		);
	}

	getRateLimitPerMinute() {
		const parsed = Number.parseInt(this.config.Rate_Limit_Per_Minute, 10);
		return Number.isInteger(parsed) && parsed > 0
			? parsed
			: DEFAULT_RATE_LIMIT_PER_MINUTE;
	}

	isSnowRequestHeaderValidationRequired() {
		return this.config.Require_Snow_Request_Headers !== false;
	}

	getRequiredSnowSourceValues(headerName) {
		return new Set(SNOW_SOURCE_CONTRACT[headerName] || []);
	}

	getAllowedSnowToolModes() {
		return new Set(splitCsv(this.config.Allowed_Snow_Tool_Modes));
	}

	getSnowRequestHeaders(data) {
		return normalizeHeaderMap(data?.requestHeaders);
	}

	hasRequestHeaders(data) {
		return Boolean(
			data &&
				typeof data === 'object' &&
				Object.prototype.hasOwnProperty.call(data, 'requestHeaders'),
		);
	}

	isSnowBridgeRequest(data) {
		if (!this.isSnowRequestHeaderValidationRequired()) {
			return true;
		}

		if (!this.hasRequestHeaders(data)) {
			return false;
		}

		const headers = this.getSnowRequestHeaders(data);
		return (
			SNOW_REQUEST_HEADER_KEYS.some(key => Boolean(headers[key]))
		);
	}

	getClientIdentity(serverId, data) {
		const snowHeaders = this.getSnowRequestHeaders(data);
		const clientInfo =
			data && typeof data.clientInfo === 'object' && data.clientInfo !== null
				? data.clientInfo
				: {};

		return (
			snowHeaders['x-snow-client'] ||
			clientInfo.clientId ||
			clientInfo.clientName ||
			clientInfo.name ||
			serverId
		);
	}

	assertSnowSourceMetadata(data) {
		if (!this.isSnowRequestHeaderValidationRequired()) {
			return;
		}

		if (!this.hasRequestHeaders(data)) {
			throw buildError(
				'bridge_source_metadata_missing',
				'SnowBridge requires requestHeaders with explicit Snow source metadata.',
			);
		}

		const headers = this.getSnowRequestHeaders(data);
		const missingHeaders = SNOW_REQUEST_HEADER_KEYS.filter(key => !headers[key]);
		if (missingHeaders.length > 0) {
			throw buildError(
				'bridge_source_metadata_invalid',
				'SnowBridge requestHeaders are missing required Snow metadata.',
				{
					details: {missingHeaders},
				},
			);
		}

		const validations = [
			{
				headerName: 'x-snow-client',
				allowedValues: this.getRequiredSnowSourceValues('x-snow-client'),
				errorCode: 'bridge_source_client_forbidden',
			},
			{
				headerName: 'x-snow-protocol',
				allowedValues: this.getRequiredSnowSourceValues('x-snow-protocol'),
				errorCode: 'bridge_source_protocol_forbidden',
			},
			{
				headerName: 'x-snow-tool-mode',
				allowedValues: this.getAllowedSnowToolModes(),
				errorCode: 'bridge_source_tool_mode_forbidden',
			},
			{
				headerName: 'x-snow-channel',
				allowedValues: this.getRequiredSnowSourceValues('x-snow-channel'),
				errorCode: 'bridge_source_channel_forbidden',
			},
		];

		for (const validation of validations) {
			const {headerName, allowedValues, errorCode} = validation;
			if (allowedValues.size === 0) {
				continue;
			}

			const actualValue = headers[headerName];
			if (!allowedValues.has(actualValue)) {
				throw buildError(
					errorCode,
					`SnowBridge rejected request header "${headerName}" with value "${actualValue}".`,
					{
						details: {
							headerName,
							actualValue,
							allowedValues: Array.from(allowedValues),
						},
					},
				);
			}
		}
	}

	assertBridgeAccess(serverId, data) {
		if (this.config.Bridge_Enabled === false) {
			throw buildError('bridge_disabled', 'SnowBridge is disabled.');
		}

		const requiredToken = this.getBridgeAccessToken();
		const providedToken = String(
			(data && (data.accessToken || data.authToken)) || '',
		).trim();
		if (requiredToken && providedToken !== requiredToken) {
			throw buildError('bridge_auth_failed', 'Invalid bridge access token.');
		}

		this.assertSnowSourceMetadata(data);

		this.assertRateLimit(serverId, data);
	}

	assertRateLimit(serverId, data) {
		const identity = this.getClientIdentity(serverId, data);
		const limit = this.getRateLimitPerMinute();
		const now = Date.now();
		const state =
			this.rateLimitState.get(identity) || {
				windowStart: now,
				count: 0,
			};

		if (now - state.windowStart >= 60_000) {
			state.windowStart = now;
			state.count = 0;
		}

		state.count += 1;
		this.rateLimitState.set(identity, state);

		if (state.count > limit) {
			throw buildError(
				'bridge_rate_limited',
				`Bridge rate limit exceeded for client "${identity}".`,
				{limit},
			);
		}
	}

	isToolAllowed(toolName) {
		const allowedTools = this.getAllowedTools();
		if (allowedTools.size === 0) {
			return true;
		}

		return allowedTools.has(toolName);
	}

	normalizeToolFilters(rawFilters) {
		if (!rawFilters) {
			return [];
		}

		if (Array.isArray(rawFilters)) {
			return rawFilters.map(value => String(value).trim()).filter(Boolean);
		}

		if (typeof rawFilters === 'object' && rawFilters !== null) {
			if (Array.isArray(rawFilters.include)) {
				return rawFilters.include.map(value => String(value).trim()).filter(Boolean);
			}
			if (typeof rawFilters.include === 'string') {
				return splitCsv(rawFilters.include);
			}
		}

		if (typeof rawFilters === 'string') {
			return splitCsv(rawFilters);
		}

		return [];
	}

	matchesToolFilter(pluginName, displayName, bridgeCommands, filters) {
		if (!filters || filters.length === 0) {
			return true;
		}

		const haystacks = [
			pluginName,
			displayName,
			...bridgeCommands.map(command => command.commandName),
		]
			.filter(Boolean)
			.map(value => value.toLowerCase());

		return filters.some(filterValue => {
			const normalized = filterValue.toLowerCase();
			return haystacks.some(haystack => haystack.includes(normalized));
		});
	}

	buildExportablePlugin(plugin, pluginName) {
		const bridgeCommands = (plugin.capabilities?.invocationCommands || [])
			.map(normalizeInvocationCommand)
			.filter(Boolean);

		if (bridgeCommands.length === 0) {
			return null;
		}

		const bridgeCapabilities = this.getBridgeCapabilities();

		return {
			name: plugin.name || pluginName,
			publicName: plugin.name || pluginName,
			originName: pluginName,
			pluginType: plugin.pluginType,
			toolId: buildBridgeToolId(pluginName),
			displayName: plugin.displayName || plugin.name || pluginName,
			description: normalizeBridgeText(plugin.description),
			capabilityTags: buildCapabilityTags(bridgeCommands, bridgeCapabilities),
			capabilities: {
				invocationCommands: plugin.capabilities?.invocationCommands || [],
			},
			bridgeCommands,
		};
	}

	sendManifestError(serverId, requestId, error) {
		this.sendToServer(serverId, {
			type: 'vcp_manifest_response',
			data: {
				requestId,
				status: 'error',
				bridgeVersion: BRIDGE_VERSION,
				vcpVersion: BRIDGE_VERSION,
				capabilities: this.getBridgeCapabilities(),
				plugins: [],
				error,
			},
		});
	}

	sendToolError(serverId, requestId, invocationId, error) {
		this.sendToServer(serverId, {
			type: 'vcp_tool_result',
			data: buildToolResultPayload(
				{
					requestId,
					invocationId,
					toolName: '',
					publicName: '',
					toolId: undefined,
					taskId: null,
				},
				{
					status: 'error',
					error,
				},
			),
		});
	}

	async handleGetManifests(serverId, message, pluginManager) {
		const data = (message && message.data) || {};
		const requestId = data.requestId;

		try {
			this.assertBridgeAccess(serverId, data);

			const excludedTools = this.getExcludedTools();
			const excludedKeywords = this.getExcludedDisplayKeywords();
			const clientFilters = this.normalizeToolFilters(data.toolFilters);
			const exportablePlugins = [];

			for (const [pluginName, plugin] of pluginManager.plugins.entries()) {
				if (excludedTools.has(pluginName)) {
					continue;
				}

				if (!this.isToolAllowed(pluginName)) {
					continue;
				}

				if (plugin.isDistributed) {
					continue;
				}

				if (
					plugin.displayName &&
					excludedKeywords.some(keyword => plugin.displayName.includes(keyword))
				) {
					continue;
				}

				const exportablePlugin = this.buildExportablePlugin(plugin, pluginName);
				if (!exportablePlugin) {
					continue;
				}

				if (
					!this.matchesToolFilter(
						exportablePlugin.name,
						exportablePlugin.displayName,
						exportablePlugin.bridgeCommands,
						clientFilters,
					)
				) {
					continue;
				}

				exportablePlugins.push(exportablePlugin);
			}

			this.sendToServer(serverId, {
				type: 'vcp_manifest_response',
				data: {
					requestId,
					status: 'success',
					bridgeVersion: BRIDGE_VERSION,
					vcpVersion: BRIDGE_VERSION,
					capabilities: this.getBridgeCapabilities(),
					plugins: exportablePlugins,
				},
			});
		} catch (error) {
			this.sendManifestError(serverId, requestId, parseToolError(error));
		}
	}

	createInvocationContext(serverId, requestId, invocationId, toolName, bridgeMeta = {}) {
		return {
			serverId,
			requestId,
			invocationId,
			toolName,
			toolId: bridgeMeta.toolId || buildBridgeToolId(toolName),
			publicName: bridgeMeta.publicName || toolName,
			taskId: null,
			cancelled: false,
			cancelledAt: null,
			createdAt: Date.now(),
		};
	}

	cleanupInvocation(invocationId) {
		const context = this.activeInvocations.get(invocationId);
		if (!context) {
			return;
		}

		if (context.cancelCleanupTimer) {
			clearTimeout(context.cancelCleanupTimer);
		}

		if (context.taskId) {
			this.taskToInvocationMap.delete(context.taskId);
		}

		this.activeInvocations.delete(invocationId);
	}

	scheduleCancelledInvocationCleanup(invocationId) {
		const context = this.activeInvocations.get(invocationId);
		if (!context || context.cancelCleanupTimer) {
			return;
		}

		context.cancelCleanupTimer = setTimeout(() => {
			this.cleanupInvocation(invocationId);
		}, CANCELLED_INVOCATION_TTL_MS);
	}

	async handleExecuteTool(serverId, message, pluginManager) {
		const data = (message && message.data) || {};
		const requestId = data.requestId;
		const invocationId = data.invocationId || requestId;
		const toolName = data.originName || data.toolName;
		const toolId = data.toolId || buildBridgeToolId(toolName || '');
		const publicName = data.publicName || data.toolName || toolName;
		const toolArgs = data.toolArgs && typeof data.toolArgs === 'object'
			? {...data.toolArgs}
			: {};

		try {
			this.assertBridgeAccess(serverId, data);

			if (!requestId || !invocationId || !toolName) {
				throw buildError(
					'bridge_invalid_request',
					'requestId, invocationId and toolName are required.',
				);
			}

			if (!this.isToolAllowed(toolName)) {
				throw buildError(
					'bridge_tool_forbidden',
					`Tool "${toolName}" is not allowed by SnowBridge.`,
				);
			}

			const context = this.createInvocationContext(
				serverId,
				requestId,
				invocationId,
				toolName,
				{
					toolId,
					publicName,
				},
			);
			this.activeInvocations.set(invocationId, context);

			const result = await pluginManager.processToolCall(toolName, toolArgs);
			const latestContext = this.activeInvocations.get(invocationId);

			if (result && result.taskId) {
				const taskId = String(result.taskId);
				if (latestContext) {
					latestContext.taskId = taskId;
					this.taskToInvocationMap.set(taskId, invocationId);
					if (latestContext.cancelled) {
						this.scheduleCancelledInvocationCleanup(invocationId);
						return;
					}
				}

				this.sendToServer(serverId, {
					type: 'vcp_tool_status',
					data: buildAsyncStatusPayload(context, {
						taskId,
						state: 'accepted',
						status: 'accepted',
						event: 'lifecycle',
						result,
					}),
				});
				return;
			}

			if (latestContext && latestContext.cancelled) {
				this.cleanupInvocation(invocationId);
				return;
			}

			this.sendToServer(serverId, {
				type: 'vcp_tool_result',
				data: buildToolResultPayload(context, {
					status: 'success',
					result,
				}),
			});
		} catch (error) {
			const context = this.activeInvocations.get(invocationId);
			if (!context || !context.cancelled) {
				const parsedError = parseToolError(error);
				if (context) {
					this.sendToServer(serverId, {
						type: 'vcp_tool_result',
						data: buildToolResultPayload(context, {
							status: 'error',
							taskId: context.taskId,
							error: parsedError,
						}),
					});
				} else {
					this.sendToolError(serverId, requestId, invocationId, parsedError);
				}
			}
		} finally {
			const context = this.activeInvocations.get(invocationId);
			if (context && !context.taskId) {
				this.cleanupInvocation(invocationId);
			}
		}
	}

	async handleCancelTool(serverId, message) {
		const data = (message && message.data) || {};
		const requestId = data.requestId;
		const invocationId = data.invocationId || requestId;

		try {
			this.assertBridgeAccess(serverId, data);

			if (!invocationId) {
				throw buildError(
					'bridge_invalid_cancel',
					'requestId or invocationId is required for cancellation.',
				);
			}

			const context = this.activeInvocations.get(invocationId);
			if (!context) {
				this.sendToServer(serverId, {
					type: 'vcp_tool_cancel_ack',
					data: {
						requestId,
						invocationId,
						accepted: false,
						mode: 'unsupported',
						error: buildError(
							'bridge_invocation_not_found',
							`Invocation "${invocationId}" was not found.`,
						),
					},
				});
				return;
			}

			context.cancelled = true;
			context.cancelledAt = Date.now();
			this.scheduleCancelledInvocationCleanup(invocationId);

			this.sendToServer(serverId, {
				type: 'vcp_tool_cancel_ack',
				data: {
					requestId,
					invocationId,
					accepted: true,
					mode: context.taskId ? 'ignored' : 'cancelled',
				},
			});
		} catch (error) {
			this.sendToServer(serverId, {
				type: 'vcp_tool_cancel_ack',
				data: {
					requestId,
					invocationId,
					accepted: false,
					mode: 'unsupported',
					error: parseToolError(error),
				},
			});
		}
	}

	async processToolCall(args) {
		if (args.command === 'GetStatus') {
			return {
				status: 'running',
				hooked: this.isHooked,
				config: this.config,
				bridgeVersion: BRIDGE_VERSION,
				capabilities: this.getBridgeCapabilities(),
			};
		}

		throw new Error(`Unknown command: ${args.command}`);
	}

	shutdown() {
		this.removeEventListeners();
		this.removeMonkeyPatch();

		for (const context of this.activeInvocations.values()) {
			if (context.cancelCleanupTimer) {
				clearTimeout(context.cancelCleanupTimer);
			}
		}
		this.activeInvocations.clear();
		this.taskToInvocationMap.clear();
		this.rateLimitState.clear();
		this.pluginManager = null;
		this.wss = null;

		if (this.debugMode) {
			console.log('[SnowBridge] Shutting down...');
		}
	}
}

module.exports = new SnowBridge();
