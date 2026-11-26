'use strict';

function normalizeToolImage(url, detail) {
    if (typeof url !== 'string' || !url ||
        !(/^https?:\/\/[^\s]+$/i.test(url) ||
          /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(url))) return null;
    return {
        type: 'image_url',
        image_url: { url, ...(['auto', 'low', 'high'].includes(detail) ? { detail } : {}) }
    };
}

/**
 * Chat's tool role carries text only. Lift images after the entire contiguous
 * assistant/tool exchange, never between results or into the conversation history.
 */
function projectNativeToolResultMedia(body) {
    const messages = body?.messages;
    if (!Array.isArray(messages)) return body;
    const projected = [];
    let changed = false;

    for (let index = 0; index < messages.length; index++) {
        const assistant = messages[index];
        projected.push(assistant);
        if (assistant?.role !== 'assistant' || !Array.isArray(assistant.tool_calls) ||
            assistant.tool_calls.length === 0) continue;

        let end = index + 1;
        while (messages[end]?.role === 'tool') end++;
        const results = messages.slice(index + 1, end);
        const ids = new Set(assistant.tool_calls.map(call => call?.id));
        const returnedIds = new Set(results.map(result => result.tool_call_id));
        if (ids.size !== assistant.tool_calls.length ||
            ids.size !== results.length || ids.size !== returnedIds.size ||
            [...ids].some(id => typeof id !== 'string' || !id || !returnedIds.has(id))) continue;

        const media = [];
        for (const result of results) {
            if (!Array.isArray(result.content)) {
                projected.push(result);
                continue;
            }

            const images = [];
            const text = [];
            for (const part of result.content) {
                if (part?.type === 'image_url') {
                    const image = normalizeToolImage(part.image_url?.url, part.image_url?.detail);
                    if (image) images.push(image);
                } else if (part?.type === 'text' && typeof part.text === 'string') {
                    text.push(part);
                }
            }
            if (!result.content.some(part => part?.type === 'image_url')) {
                projected.push(result);
                continue;
            }

            changed = true;
            const label = `Tool result ${JSON.stringify(result.tool_call_id)}`;
            const notice = images.length
                ? `[${label}: ${images.length} image(s) attached after the tool batch.]`
                : `[${label}: no supported image payload.]`;
            projected.push({ ...result, content: [...text.map(part => part.text), notice].join('\n') });
            if (images.length) media.push({ type: 'text', text: `${label} — image attachment(s):` }, ...images);
        }
        if (media.length) projected.push({ role: 'user', content: media });
        index = end - 1;
    }

    return changed ? { ...body, messages: projected } : body;
}

module.exports = { normalizeToolImage, projectNativeToolResultMedia };