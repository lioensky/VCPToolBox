const MARKDOWN_IMAGE_REGEX = /!\[.*?\]\((data:image\/\w+;base64,[\s\S]*?)\)/;

function normalizeText(value) {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => normalizeText(item))
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    if (value && typeof value === 'object') {
        if (typeof value.text === 'string') {
            return value.text;
        }
        if (typeof value.content === 'string') {
            return value.content;
        }
    }

    return '';
}

export function extractImageAndTextFromMessage(message) {
    const content = message?.content;
    let textContent = '';
    let imageUrl = null;

    if (typeof content === 'string') {
        textContent = content;
        const match = textContent.match(MARKDOWN_IMAGE_REGEX);
        if (match) {
            imageUrl = match[1];
            textContent = textContent.replace(MARKDOWN_IMAGE_REGEX, '').trim();
        }
    } else if (Array.isArray(content)) {
        const textParts = [];

        for (const item of content) {
            if (!item) {
                continue;
            }

            if (typeof item === 'string') {
                const match = item.match(MARKDOWN_IMAGE_REGEX);
                if (match && !imageUrl) {
                    imageUrl = match[1];
                    const stripped = item.replace(MARKDOWN_IMAGE_REGEX, '').trim();
                    if (stripped) {
                        textParts.push(stripped);
                    }
                } else if (item.trim()) {
                    textParts.push(item.trim());
                }
                continue;
            }

            if (item.type === 'text' && typeof item.text === 'string') {
                textParts.push(item.text.trim());
                continue;
            }

            if (item.type === 'image_url' && item.image_url?.url && !imageUrl) {
                imageUrl = item.image_url.url;
                continue;
            }

            const normalized = normalizeText(item);
            if (normalized) {
                textParts.push(normalized.trim());
            }
        }

        textContent = textParts.filter(Boolean).join('\n').trim();
    } else {
        textContent = normalizeText(content);
    }

    if (!imageUrl && Array.isArray(message?.images) && message.images.length > 0) {
        imageUrl = message.images[0]?.image_url?.url || null;
    }

    return { textContent, imageUrl };
}
