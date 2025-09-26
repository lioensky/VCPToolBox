// modules/renderer/domBuilder.js

/**
 * @typedef {import('./messageRenderer.js').Message} Message
 * @typedef {import('./messageRenderer.js').CurrentSelectedItem} CurrentSelectedItem
 */

/**
 * Creates the basic HTML structure (skeleton) for a message item.
 * @param {Message} message - The message object.
 * @param {object} globalSettings - The global settings object.
 * @param {CurrentSelectedItem} currentSelectedItem - The currently selected agent or group.
 * @returns {{
 *   messageItem: HTMLElement,
 *   contentDiv: HTMLElement,
 *   avatarImg: HTMLImageElement | null,
 *   senderNameDiv: HTMLElement | null,
 *   nameTimeDiv: HTMLElement | null,
 *   detailsAndBubbleWrapper: HTMLElement | null
 * }} An object containing the created DOM elements.
 */
export function createMessageSkeleton(message, globalSettings, currentSelectedItem) {
    const messageItem = document.createElement('div');
    messageItem.classList.add('message-item', message.role);
    if (message.isGroupMessage) messageItem.classList.add('group-message-item');
    messageItem.dataset.timestamp = String(message.timestamp);
    messageItem.dataset.messageId = message.id;
    if (message.agentId) messageItem.dataset.agentId = message.agentId;

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('md-content');

    let avatarImg = null,
        nameTimeDiv = null,
        senderNameDiv = null,
        detailsAndBubbleWrapper = null;
    let avatarUrlToUse, senderNameToUse;

    if (message.role === 'user') {
        avatarUrlToUse = globalSettings.userAvatarUrl || 'assets/default_user_avatar.png';
        senderNameToUse = message.name || globalSettings.userName || '你';
    } else if (message.role === 'assistant') {
        if (message.isGroupMessage) {
            avatarUrlToUse = message.avatarUrl || 'assets/default_avatar.png';
            senderNameToUse = message.name || '群成员';
        } else if (currentSelectedItem && currentSelectedItem.avatarUrl) {
            avatarUrlToUse = currentSelectedItem.avatarUrl;
            senderNameToUse = message.name || currentSelectedItem.name || 'AI';
        } else {
            avatarUrlToUse = 'assets/default_avatar.png';
            senderNameToUse = message.name || 'AI';
        }
    }

    if (message.role === 'user' || message.role === 'assistant') {
        avatarImg = document.createElement('img');
        avatarImg.classList.add('chat-avatar');
        avatarImg.src = avatarUrlToUse;
        avatarImg.alt = `${senderNameToUse} 头像`;
        avatarImg.onerror = () => { avatarImg.src = message.role === 'user' ? 'assets/default_user_avatar.png' : 'assets/default_avatar.png'; };

        nameTimeDiv = document.createElement('div');
        nameTimeDiv.classList.add('name-time-block');

        senderNameDiv = document.createElement('div');
        senderNameDiv.classList.add('sender-name');
        senderNameDiv.textContent = senderNameToUse;

        nameTimeDiv.appendChild(senderNameDiv);

        if (message.timestamp && !message.isThinking) {
            const timestampDiv = document.createElement('div');
            timestampDiv.classList.add('message-timestamp');
            timestampDiv.textContent = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            nameTimeDiv.appendChild(timestampDiv);
        }

        detailsAndBubbleWrapper = document.createElement('div');
        detailsAndBubbleWrapper.classList.add('details-and-bubble-wrapper');
        detailsAndBubbleWrapper.appendChild(nameTimeDiv);
        detailsAndBubbleWrapper.appendChild(contentDiv);

        messageItem.appendChild(avatarImg);
        messageItem.appendChild(detailsAndBubbleWrapper);
    } else { // system messages
        messageItem.appendChild(contentDiv);
        messageItem.classList.add('system-message-layout');
    }

    return { messageItem, contentDiv, avatarImg, senderNameDiv, nameTimeDiv, detailsAndBubbleWrapper };
}

// Expose to global scope for classic scripts
window.domBuilder = {
    createMessageSkeleton
};