const axios = require('axios');
const crypto = require('crypto');

const API_BASE_PATH = '/api/v1';
let panelHost = process.env.PANEL_HOST;
let apiKey = process.env.PANEL_API_KEY;
let apiBaseUrl = panelHost ? `${panelHost}${API_BASE_PATH}` : '';

function md5Sum(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function setApiKey(key) {
  apiKey = key;
}

function getApiKey() {
  return apiKey;
}

function setHost(host) {
  panelHost = host;
  if (panelHost) {
    apiBaseUrl = `${panelHost}${API_BASE_PATH}`;
  } else {
    apiBaseUrl = '';
  }
}

function getApiBaseUrl() {
  if (!apiBaseUrl && panelHost) {
    apiBaseUrl = `${panelHost}${API_BASE_PATH}`;
  }
  return apiBaseUrl;
}

function getRandomStr(length) {
  const charset = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
  let result = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    result += charset[randomIndex];
  }
  return result;
}

class PanelClient {
  constructor(method, path, payload = null, query = null, headers = {}) {
    this.method = method.toUpperCase();
    const baseUrl = getApiBaseUrl();
    if (!baseUrl) {
      throw new Error('Panel host is not set. Please set PANEL_HOST environment variable or call setHost().');
    }
    this.url = `${baseUrl}${path}`;
    this.payload = payload;
    this.query = query;
    this.headers = {
      'Content-Type': 'application/json',
      'User-Agent': `panel-client Node.js/${process.platform}/${process.arch}/node-${process.version}`,
      ...headers,
    };

    if (this.query) {
      const urlObj = new URL(this.url);
      Object.entries(this.query).forEach(([key, value]) => {
        urlObj.searchParams.set(key, String(value));
      });
      this.url = urlObj.toString();
    }
  }

  async request() {
    const currentApiKey = getApiKey();
    if (!currentApiKey) {
      throw new PanelError(401, 'Unauthorized', 'Panel API key is missing or invalid. Please set PANEL_API_KEY environment variable or call setApiKey().');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sign = md5Sum(`1panel${currentApiKey}${timestamp}`);

    this.headers['1Panel-Token'] = sign;
    this.headers['1Panel-Timestamp'] = timestamp;
    
    const config = {
      method: this.method,
      url: this.url,
      headers: this.headers,
      data: this.payload,
      timeout: 30000, // 30 seconds timeout
    };

    try {
      const response = await axios(config);
      // Check for successful status codes (2xx, 304)
      if (response.status >= 200 && response.status < 300 || response.status === 304) {
        // The Go client seems to return the parsed response body directly for some successful operations
        // or a message for others. For simplicity and consistency with common JS patterns,
        // we will return response.data which is already parsed by axios if it's JSON.
        // If the response is empty (e.g. 204 No Content), data might be undefined or null.
        return response.data !== undefined ? response.data : { message: "Operation completed successfully" };
      } else {
        // This case should ideally be caught by the catch block for axios errors
        throw new PanelError(response.status, response.statusText, response.data ? (response.data.message || JSON.stringify(response.data)) : 'No error details');
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          const { status, statusText, data } = error.response;
          const errorMessage = data && data.message ? data.message : (typeof data === 'string' ? data : statusText);
          throw new PanelError(status, statusText, errorMessage);
        } else if (error.request) {
          // The request was made but no response was received
          throw new PanelError(0, 'Network Error', 'Unable to connect to Panel API. No response received.');
        } else {
          // Something happened in setting up the request that triggered an Error
          throw new PanelError(0, 'Request Setup Error', error.message);
        }
      } else {
        // Non-Axios error
        throw new PanelError(500, 'Internal Error', error.message);
      }
    }
  }
}

class PanelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PanelError';
    this.code = code;
    this.details = details;
    // Maintaining prototype chain
    Object.setPrototypeOf(this, PanelError.prototype);
  }

  toString() {
    return `Panel API error: ${this.message} (code: ${this.code})${this.details ? ` - ${this.details}` : ''}`;
  }
}

function newPanelClient(method, urlPath, payload = null, query = null, headers = {}) {
    // The Go version had options like WithPayload, WithQuery. 
    // In JS, it's more idiomatic to pass these as direct arguments or an options object.
    // For simplicity, we'll pass them directly here.
    return new PanelClient(method, urlPath, payload, query, headers);
}

module.exports = {
  setApiKey,
  getApiKey,
  setHost,
  getApiBaseUrl,
  getRandomStr,
  newPanelClient,
  PanelError,
  // Exposing md5Sum if it's needed externally, though it's mainly internal for auth
  // md5Sum 
}; 