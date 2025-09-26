// modules/renderer/enhancedColorUtils.js

// Enhanced cache with TTL support
class TTLCache {
    constructor(ttl = 24 * 60 * 60 * 1000) { // 24 hours default
        this.cache = new Map();
        this.ttl = ttl;
    }

    set(key, value) {
        const item = {
            value,
            timestamp: Date.now(),
            expires: Date.now() + this.ttl
        };
        this.cache.set(key, item);
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        if (Date.now() > item.expires) {
            this.cache.delete(key);
            return null;
        }
        
        return item.value;
    }

    has(key) {
        const item = this.cache.get(key);
        if (!item) return false;
        
        if (Date.now() > item.expires) {
            this.cache.delete(key);
            return false;
        }
        
        return true;
    }

    delete(key) {
        return this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
    }

    // Clean up expired entries
    cleanup() {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now > item.expires) {
                this.cache.delete(key);
            }
        }
    }

    // Get cache statistics
    getStats() {
        const now = Date.now();
        let expired = 0;
        let valid = 0;
        
        for (const [key, item] of this.cache.entries()) {
            if (now > item.expires) {
                expired++;
            } else {
                valid++;
            }
        }
        
        return {
            total: this.cache.size,
            valid,
            expired
        };
    }
}

// Enhanced avatar color cache with TTL
export const avatarColorCache = new TTLCache(24 * 60 * 60 * 1000); // 24 hours

// Start periodic cleanup
setInterval(() => {
    avatarColorCache.cleanup();
}, 60 * 60 * 1000); // Clean up every hour

// Enhanced color extraction with better error handling
export function getDominantAvatarColor(imageUrl) {
    return new Promise((resolve) => {
        if (!imageUrl) {
            resolve(null);
            return;
        }

        const cacheKey = imageUrl.split('?')[0];
        const cachedColor = avatarColorCache.get(cacheKey);
        if (cachedColor !== null) {
            resolve(cachedColor);
            return;
        }

        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        const timeoutId = setTimeout(() => {
            console.warn(`Color extraction timeout for: ${imageUrl}`);
            avatarColorCache.set(cacheKey, null);
            resolve(null);
        }, 5000); // 5 second timeout

        img.onload = () => {
            clearTimeout(timeoutId);
            
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                // Use smaller canvas for better performance
                const size = Math.min(img.width, img.height, 100);
                canvas.width = size;
                canvas.height = size;
                
                ctx.drawImage(img, 0, 0, size, size);
                const imageData = ctx.getImageData(0, 0, size, size);
                const data = imageData.data;
                
                const colorCounts = {};
                const step = 4; // Sample every 4th pixel for performance
                
                for (let i = 0; i < data.length; i += 4 * step) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const a = data[i + 3];
                    
                    // Skip transparent pixels
                    if (a < 128) continue;
                    
                    // Skip very light or very dark colors
                    const brightness = (r + g + b) / 3;
                    if (brightness < 30 || brightness > 225) continue;
                    
                    // Quantize colors to reduce noise
                    const quantizedR = Math.round(r / 32) * 32;
                    const quantizedG = Math.round(g / 32) * 32;
                    const quantizedB = Math.round(b / 32) * 32;
                    
                    const colorKey = `${quantizedR},${quantizedG},${quantizedB}`;
                    colorCounts[colorKey] = (colorCounts[colorKey] || 0) + 1;
                }
                
                // Find the most common color
                let dominantColor = null;
                let maxCount = 0;
                
                for (const [colorKey, count] of Object.entries(colorCounts)) {
                    if (count > maxCount) {
                        maxCount = count;
                        const [r, g, b] = colorKey.split(',').map(Number);
                        dominantColor = `rgb(${r}, ${g}, ${b})`;
                    }
                }
                
                // Fallback to a default color if no dominant color found
                const finalColorString = dominantColor || 'rgb(128, 128, 128)';
                
                avatarColorCache.set(cacheKey, finalColorString);
                resolve(finalColorString);
                
            } catch (e) {
                console.error(`[AvatarColor] Error processing ${imageUrl}:`, e);
                avatarColorCache.set(cacheKey, null);
                resolve(null);
            }
        };

        img.onerror = () => {
            clearTimeout(timeoutId);
            console.warn(`Failed to load image for color extraction: ${imageUrl}`);
            avatarColorCache.set(cacheKey, null);
            resolve(null);
        };

        img.src = imageUrl;
    });
}

// Export cache for debugging
export { TTLCache };