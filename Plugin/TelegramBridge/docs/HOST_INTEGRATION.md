# Host Integration v1

The host exposes getIntegrationCapabilities() on the injected pluginManager, with hostIntegrationVersion=1, approvalCorrelationVersion=1, asyncCorrelationVersion=1 and approvalResponseMethod=handleApprovalResponse.

Both stream and non-stream tool execution propagate requestId/messageId from the original request as parentRequestId/parentMessageId. The bridge generates these IDs and accepts events only when they match its durable owner/scope ledger.

The host emits minimal same-process tool_approval_request, async_task_receipt and async_task_completed events. Approval events omit tool arguments and user content; the existing administrator authentication remains authoritative. Async results are persisted before completion is emitted. Listener failures are isolated so a transport cannot interrupt host execution. Existing WebSocket clients retain their approval preview and callback notifications.

Only asynchronous plugin receipts with a recognized task ID are associated automatically. Provider-specific structured artifact formats are outside this transport contract; generic result text and supported media links are handled normally.
