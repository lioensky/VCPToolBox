# ServerFileAttach

`ServerFileAttach` lets an Agent register a server-side file as a standard chat attachment without embedding file bytes into model context.

It is for "send this server file to the user", not for "read this file into the prompt". The plugin returns attachment metadata, and clients download the bytes through VCPToolBox.

## Tool Call

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ServerFileAttach「末」,
command:「始」AttachFile「末」,
filePath:「始」file/report.pdf「末」,
name:「始」report.pdf「末」
<<<[END_TOOL_REQUEST]>>>
```

Supported parameters:

- `command`: `AttachFile` or `RegisterFile`.
- `filePath`, `sourcePath`, or `src`: required source file path or `file://` URL.
- `name`: optional display name.
- `type` or `mimeType`: optional MIME override.
- `disposition`: optional, defaults to `download`.

## Result Protocol

The result includes both `attachments` and `vcp_attachments`:

```json
{
  "serverAttachmentId": "att_...",
  "name": "report.pdf",
  "type": "application/pdf",
  "size": 123456,
  "src": "file:///D:/VCP/VCPToolBox/file/report.pdf",
  "hash": "sha256:...",
  "downloadUrl": "/v1/attachments/att_...",
  "disposition": "download"
}
```

Streaming chat responses can forward these as `vcp.attachment.chunk`. Non-stream responses can expose them as top-level `vcp_attachments` and `attachments`.

## Safety

- `ALLOWED_ATTACHMENT_ROOTS` is a semicolon-separated whitelist. When unset, it defaults to the project-local `file` directory.
- `MAX_ATTACHMENT_BYTES` limits single-file size.
- Downloads re-check source path, size, and hash before serving.
- Clients download through `/v1/attachments/:serverAttachmentId`; they must not parse or use `src`.
- Download auth accepts `SERVER_ATTACHMENT_KEY`, falling back to global `VCP_Key` or `Key`.
