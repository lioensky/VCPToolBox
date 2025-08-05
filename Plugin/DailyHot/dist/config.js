"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;

// Based on the original project's config.ts and .env.example
// We provide default values directly here to ensure the plugin works out-of-the-box.
exports.config = {
  // Request timeout in milliseconds
  REQUEST_TIMEOUT: 6000,
  // Cache time-to-live in seconds
  CACHE_TTL: 3600,
};