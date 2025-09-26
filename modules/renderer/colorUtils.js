// modules/renderer/colorUtils.js

// Cache for dominant avatar colors
export const avatarColorCache = new Map();

// --- Helper functions for color conversion ---
export function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h * 360, s * 100, l * 100]; // Hue in degrees, S/L in %
}

export function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    let c = (1 - Math.abs(2 * l - 1)) * s,
        x = c * (1 - Math.abs((h / 60) % 2 - 1)),
        m = l - c / 2,
        r = 0, g = 0, b = 0;

    if (0 <= h && h < 60) { r = c; g = x; b = 0; }
    else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
    else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
    else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
    else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
    else if (300 <= h && h < 360) { r = c; g = 0; b = x; }
    
    r = Math.round((r + m) * 255);
    g = Math.round((g + m) * 255);
    b = Math.round((b + m) * 255);
    return `rgb(${r},${g},${b})`;
}

/**
 * Extracts a more vibrant and representative color from an image.
 * @param {string} imageUrl The URL of the image.
 * @returns {Promise<string|null>} A promise that resolves with the CSS color string or null.
 */
export async function getDominantAvatarColor(imageUrl) {
    if (!imageUrl) return null;

    const cacheKey = imageUrl.split('?')[0];
    if (avatarColorCache.has(cacheKey)) {
        return avatarColorCache.get(cacheKey);
    }

    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = imageUrl;

        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const tempCanvasSize = 30;
            canvas.width = tempCanvasSize;
            canvas.height = tempCanvasSize;
            ctx.drawImage(img, 0, 0, tempCanvasSize, tempCanvasSize);

            let bestHue = null;
            let maxSaturation = -1;
            let r_sum = 0, g_sum = 0, b_sum = 0, pixelCount = 0;

            try {
                const imageData = ctx.getImageData(0, 0, tempCanvasSize, tempCanvasSize);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i], g = data[i+1], b = data[i+2], alpha = data[i+3];
                    if (alpha < 128) continue;
                    const [h, s, l] = rgbToHsl(r, g, b);
                    if (s > 20 && l >= 30 && l <= 80) {
                        if (s > maxSaturation) { maxSaturation = s; bestHue = h; }
                        r_sum += r; g_sum += g; b_sum += b; pixelCount++;
                    }
                }
                let finalColorString = null;
                if (bestHue !== null) {
                    finalColorString = hslToRgb(bestHue, 75, 55);
                } else if (pixelCount > 0) {
                    const [h_avg, s_avg, l_avg] = rgbToHsl(r_sum/pixelCount, g_sum/pixelCount, b_sum/pixelCount);
                    finalColorString = hslToRgb(h_avg, s_avg, Math.max(40, Math.min(70, l_avg)));
                }
                avatarColorCache.set(cacheKey, finalColorString);
                resolve(finalColorString);
            } catch (e) {
                console.error(`[AvatarColor] Error processing ${imageUrl}:`, e);
                avatarColorCache.set(cacheKey, null);
                resolve(null);
            }
        };
        img.onerror = () => {
            console.warn(`Failed to load image for color extraction: ${imageUrl}`);
            avatarColorCache.set(cacheKey, null);
            resolve(null);
        };
    });
}

// Expose to global scope for classic scripts like renderer.js
window.getDominantAvatarColor = getDominantAvatarColor;