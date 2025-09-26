// modules/renderer/animation.js

/**
 * Animates a new message appearing in the chat.
 * @param {HTMLElement} messageItem - The message element to animate.
 */
export function animateMessageIn(messageItem) {
    if (!window.anime) return;

    // Set initial state before animation
    messageItem.style.opacity = 0;
    messageItem.style.transform = 'translateY(20px)';

    anime({
        targets: messageItem,
        opacity: 1,
        translateY: 0,
        duration: 500,
        easing: 'easeOutExpo',
        complete: () => {
            // Clean up inline styles after animation
            messageItem.style.opacity = '';
            messageItem.style.transform = '';
        }
    });
}

/**
 * Animates a message being removed from the chat.
 * @param {HTMLElement} messageItem - The message element to animate.
 * @param {function} onComplete - Callback function to execute after the animation is complete.
 */
export function animateMessageOut(messageItem, onComplete) {
    if (!window.anime) {
        onComplete(); // If anime.js is not available, just run the callback
        return;
    }

    anime({
        targets: messageItem,
        opacity: 0,
        translateY: -20,
        duration: 400,
        easing: 'easeInExpo',
        complete: () => {
            onComplete();
        }
    });
}

/**
 * Finds and executes script tags within a given HTML element.
 * This is necessary because scripts inserted via innerHTML are not automatically executed.
 * @param {HTMLElement} containerElement - The element to search for scripts within.
 */
export function processAnimationsInContent(containerElement) {
    if (!containerElement) return;

    const scripts = Array.from(containerElement.querySelectorAll('script'));
    scripts.forEach(oldScript => {
        // Do not execute scripts that are clearly data blocks
        if (oldScript.type && oldScript.type !== 'text/javascript' && oldScript.type !== 'application/javascript') {
            return;
        }

        const newScript = document.createElement('script');
        
        // Copy attributes
        Array.from(oldScript.attributes).forEach(attr => {
            newScript.setAttribute(attr.name, attr.value);
        });
        
        // Copy content
        newScript.textContent = oldScript.textContent;
        
        // Replace the old script with the new one in the DOM to execute it
        if (oldScript.parentNode) {
            oldScript.parentNode.replaceChild(newScript, oldScript);
        }
    });
}