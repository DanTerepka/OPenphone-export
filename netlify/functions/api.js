// Netlify Function - API Proxy with Rate Limit Handling
const fetch = require('node-fetch');

const API_KEY = process.env.OPENPHONE_API_KEY;
const BASE_URL = 'https://api.openphone.com/v1';

// Rate limit tracking
let requestCount = 0;
let windowStart = Date.now();
const REQUEST_LIMIT = 9; // Stay under 10/sec to be safe
const WINDOW_MS = 1000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enforceRateLimit() {
  const now = Date.now();
  const elapsed = now - windowStart;
  
  // Reset window if needed
  if (elapsed >= WINDOW_MS) {
    requestCount = 0;
    windowStart = now;
  }
  
  // If we've hit limit, wait for window to reset
  if (requestCount >= REQUEST_LIMIT) {
    const waitTime = WINDOW_MS - elapsed;
    if (waitTime > 0) {
      console.log(`Rate limit: Waiting ${waitTime}ms before next request`);
      await sleep(waitTime);
      requestCount = 0;
      windowStart = Date.now();
    }
  }
  
  requestCount++;
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await enforceRateLimit();
      
      const response = await fetch(url, options);
      
      // Handle rate limit errors with exponential backoff
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '1');
        const waitTime = Math.min((retryAfter * 1000) * Math.pow(2, attempt), 30000);
        console.log(`Rate limited. Waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);
        await sleep(waitTime);
        continue;
      }
      
      // Handle other errors
      if (!response.ok && response.status >= 500) {
        if (attempt < maxRetries - 1) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Server error (${response.status}). Retrying in ${waitTime}ms...`);
          await sleep(waitTime);
          continue;
        }
      }
      
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`Request failed: ${error.message}. Retrying in ${waitTime}ms...`);
        await sleep(waitTime);
      }
    }
  }
  
  throw lastError || new Error('Max retries exceeded');
}

exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  // Handle OPTIONS request for CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // Check for API key
  if (!API_KEY) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({
        error: 'OPENPHONE_API_KEY environment variable is not set. Please configure it in Netlify.'
      })
    };
  }

  try {
    // Parse query parameters
    const params = event.queryStringParameters || {};
    const endpoint = params.endpoint || '';
    
    // Remove endpoint from params
    delete params.endpoint;
    
    // Build URL with query params
    const url = new URL(`${BASE_URL}${endpoint}`);
    Object.keys(params).forEach(key => {
      if (params[key]) url.searchParams.append(key, params[key]);
    });
    
    // Make request with retry and rate limit handling
    const response = await fetchWithRetry(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: {
          ...headers,
          'X-RateLimit-Reset': response.headers.get('X-RateLimit-Reset') || ''
        },
        body: JSON.stringify({ 
          error: data.message || 'API request failed',
          retryAfter: response.headers.get('retry-after')
        })
      };
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data)
    };
    
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Internal server error' })
    };
  }
};
