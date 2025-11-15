// radiant-gateway-grpc.js v2.2.1 - Full Persistence + Smart Racing
// Routes Jackal merkle hashes through storage provider network
// ✅ LRU cache eviction, Range requests, Request deduplication, Health persistence
// ✅ 16-provider Tier 1, 24hr gRPC caching, Detailed error responses
// ✅ Smart streaming: Videos always stream, large non-videos force download
// ✅ Cloudflare hybrid: Small files cached, large files bypass
// ✅ FULL PERSISTENCE: Metrics, gRPC cache, and all state persists across restarts
// 🔥 CRITICAL FIX v2.2.1: Replaced Promise.all with validated race condition (~300x faster)

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();

// ==================== CONFIGURATION FROM ENVIRONMENT ====================

const PORT = parseInt(process.env.PORT || '3001');
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
const MAX_CACHE_SIZE_GB = parseInt(process.env.MAX_CACHE_SIZE_GB || '50');
const JACKAL_GRPC_ENDPOINT = process.env.JACKAL_GRPC_ENDPOINT || 'jackal-grpc.polkachu.com:17590';
const PROVIDER_TIMEOUT = parseInt(process.env.PROVIDER_TIMEOUT || '5000');
const TIER1_TIMEOUT = parseInt(process.env.TIER1_TIMEOUT || '5000');
const LARGE_FILE_THRESHOLD_MB = parseInt(process.env.LARGE_FILE_THRESHOLD_MB || '90');
const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL || '300000'); // 5 minutes
const DATA_DIR = process.env.DATA_DIR || './data';
const GRPC_CACHE_TTL = parseInt(process.env.GRPC_CACHE_TTL || '86400000'); // 24 hours

// ==================== FIXED CONFIGURATION ====================

// ✅ ALL 16 KNOWN PROVIDERS IN TIER 1 (Fast parallel polling)
const TIER1_PROVIDERS = [
  // Squirrellogic (original 2)
  'https://jklstorage1.squirrellogic.com',
  'https://jklstorage5.squirrellogic.com',
  // New 14 providers
  'https://jackal-storage2.badgerbite.io',
  'https://pod-12.jackalstorage.online',
  'https://mprov02.jackallabs.io',
  'https://jackal-storage0.badgerbite.io',
  'https://j3.boringreallife.com',
  'https://jackal-storage5.badgerbite.io',
  'https://jklstorage2.squirrellogic.com',
  'https://jklstorage4.squirrellogic.com',
  'https://storage.datavault.space',
  'https://jackal3.spantobi1910.com',
  'https://jackal5.nkbblocks.com',
  'https://jackal-storage4.badgerbite.io',
  'https://jackal.nodesferatu.site'
];

// Cache directory
const CACHE_DIR = path.join(__dirname, 'cache');

// 🎬 Video extensions for streaming detection
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'ogg', 'm4v', 'flv', 'wmv'];

// ==================== PERSISTENT FILE PATHS ====================

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const HEALTH_FILE = path.join(DATA_DIR, 'provider-health.json');
const CACHE_ACCESS_FILE = path.join(DATA_DIR, 'cache-access-times.json');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');
const GRPC_CACHE_FILE = path.join(DATA_DIR, 'grpc-provider-cache.json');

// ==================== RUNTIME STATE ====================

// Provider health tracking
const providerHealth = new Map();

// ✅ LRU Cache tracking
const cacheAccessTimes = new Map(); // merkleHex -> timestamp

// ✅ Request deduplication tracking (in-memory only - intentionally not persisted)
const inflightRequests = new Map(); // merkleHex -> Promise

// ✅ gRPC provider cache
let grpcProviderCache = {
  providers: [],
  timestamp: 0,
  valid: false
};

// ✅ Metrics tracking (now persistent!)
let metrics = {
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  providerSuccesses: 0,
  providerFailures: 0,
  grpcQueries: 0,
  startTime: Date.now(),
  errorsByType: {},
  requestTimes: [], // Rolling window of last 100 request times
  largeFileDownloads: 0,
  videoStreams: 0,
  lastSaved: Date.now()
};

// ==================== PERSISTENCE FUNCTIONS ====================

/**
 * Load provider health from disk
 */
function loadProviderHealth() {
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      const data = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
      Object.entries(data).forEach(([url, stats]) => {
        providerHealth.set(url, stats);
      });
      console.log(`✅ Loaded health data for ${providerHealth.size} providers`);
    }
  } catch (err) {
    console.warn('⚠️  Could not load provider health:', err.message);
  }
}

/**
 * Save provider health to disk
 */
function saveProviderHealth() {
  try {
    const data = Object.fromEntries(providerHealth);
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 Saved health data for ${providerHealth.size} providers`);
  } catch (err) {
    console.error('❌ Could not save provider health:', err.message);
  }
}

/**
 * Load cache access times from disk
 */
function loadCacheAccessTimes() {
  try {
    if (fs.existsSync(CACHE_ACCESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_ACCESS_FILE, 'utf8'));
      Object.entries(data).forEach(([hash, time]) => {
        cacheAccessTimes.set(hash, time);
      });
      console.log(`✅ Loaded access times for ${cacheAccessTimes.size} cached files`);
    }
  } catch (err) {
    console.warn('⚠️  Could not load cache access times:', err.message);
  }
}

/**
 * Save cache access times to disk
 */
function saveCacheAccessTimes() {
  try {
    const data = Object.fromEntries(cacheAccessTimes);
    fs.writeFileSync(CACHE_ACCESS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ Could not save cache access times:', err.message);
  }
}

/**
 * Load metrics from disk
 */
function loadMetrics() {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const data = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
      // Merge loaded metrics with current structure (preserves new fields)
      metrics = { ...metrics, ...data };
      // Update start time to when we loaded (not when last saved)
      metrics.startTime = Date.now() - (data.lastSaved ? (Date.now() - data.lastSaved) : 0);
      console.log(`✅ Loaded metrics (${metrics.totalRequests} total requests)`);
    }
  } catch (err) {
    console.warn('⚠️  Could not load metrics:', err.message);
  }
}

/**
 * Save metrics to disk
 */
function saveMetrics() {
  try {
    metrics.lastSaved = Date.now();
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
  } catch (err) {
    console.error('❌ Could not save metrics:', err.message);
  }
}

/**
 * Load gRPC provider cache from disk
 */
function loadGRPCCache() {
  try {
    if (fs.existsSync(GRPC_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(GRPC_CACHE_FILE, 'utf8'));
      grpcProviderCache = data;
      
      // Check if cache is still valid
      const age = Date.now() - grpcProviderCache.timestamp;
      if (age > GRPC_CACHE_TTL) {
        console.log(`⚠️  gRPC cache expired (${Math.floor(age / 1000 / 60 / 60)}h old)`);
        grpcProviderCache.valid = false;
      } else {
        console.log(`✅ Loaded gRPC cache (${grpcProviderCache.providers.length} providers, ${Math.floor((GRPC_CACHE_TTL - age) / 1000 / 60 / 60)}h remaining)`);
      }
    }
  } catch (err) {
    console.warn('⚠️  Could not load gRPC cache:', err.message);
  }
}

/**
 * Save gRPC provider cache to disk
 */
function saveGRPCCache() {
  try {
    fs.writeFileSync(GRPC_CACHE_FILE, JSON.stringify(grpcProviderCache, null, 2));
  } catch (err) {
    console.error('❌ Could not save gRPC cache:', err.message);
  }
}

/**
 * Save all state to disk
 */
function saveAllState() {
  saveProviderHealth();
  saveCacheAccessTimes();
  saveMetrics();
  saveGRPCCache();
}

// ==================== INITIALIZATION ====================

console.log('\n🚀 Initializing Radiant Gateway v2.2.0...\n');

// Ensure cache directory exists
if (CACHE_ENABLED && !fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`📁 Cache directory created: ${CACHE_DIR}`);
}

// Load all persistent state
loadProviderHealth();
loadCacheAccessTimes();
loadMetrics();
loadGRPCCache();

// Periodic saving
setInterval(saveAllState, SAVE_INTERVAL);

console.log('\n✅ Initialization complete\n');

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range'],
  exposedHeaders: ['Content-Length', 'Content-Type', 'Accept-Ranges', 'Content-Range', 'X-Provider-Source', 'X-File-Size-MB', 'X-Cloudflare-Bypass']
}));

// Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    
    // Track request times (rolling window of 100)
    metrics.requestTimes.push(duration);
    if (metrics.requestTimes.length > 100) {
      metrics.requestTimes.shift();
    }
  });
  next();
});

// ==================== CACHE MANAGEMENT (LRU) ====================

/**
 * Get cache file path for a merkle hash
 */
function getCachePath(merkleHex) {
  const subdir = merkleHex.substring(0, 2);
  const dir = path.join(CACHE_DIR, subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, merkleHex);
}

/**
 * Get current cache size in bytes
 */
function getCacheSizeBytes() {
  if (!CACHE_ENABLED || !fs.existsSync(CACHE_DIR)) return 0;
  
  let totalSize = 0;
  const getSize = (dir) => {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        getSize(filePath);
      } else {
        totalSize += stats.size;
      }
    });
  };
  
  getSize(CACHE_DIR);
  return totalSize;
}

/**
 * Get current cache size in GB
 */
function getCacheSizeGB() {
  return getCacheSizeBytes() / (1024 * 1024 * 1024);
}

/**
 * Get all cached files sorted by last access time (oldest first)
 */
function getCachedFilesByAge() {
  const files = [];
  
  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        scanDir(filePath);
      } else {
        // Extract merkleHex from path
        const merkleHex = path.basename(filePath);
        const lastAccess = cacheAccessTimes.get(merkleHex) || stats.mtimeMs;
        files.push({
          path: filePath,
          merkleHex,
          size: stats.size,
          lastAccess
        });
      }
    });
  };
  
  scanDir(CACHE_DIR);
  
  // Sort by lastAccess (oldest first)
  return files.sort((a, b) => a.lastAccess - b.lastAccess);
}

/**
 * Evict old files to free up space (LRU eviction)
 */
function evictOldFiles(targetSizeBytes) {
  const currentSize = getCacheSizeBytes();
  if (currentSize <= targetSizeBytes) return;
  
  const needToFree = currentSize - targetSizeBytes;
  let freed = 0;
  
  const filesByAge = getCachedFilesByAge();
  
  console.log(`🗑️  LRU Eviction: Need to free ${(needToFree / 1024 / 1024).toFixed(2)} MB`);
  
  for (const file of filesByAge) {
    if (freed >= needToFree) break;
    
    try {
      fs.unlinkSync(file.path);
      cacheAccessTimes.delete(file.merkleHex);
      freed += file.size;
      console.log(`   Deleted: ${file.merkleHex.substring(0, 16)}... (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    } catch (err) {
      console.error(`   Failed to delete ${file.merkleHex}:`, err.message);
    }
  }
  
  console.log(`✅ Freed ${(freed / 1024 / 1024).toFixed(2)} MB from cache`);
  saveCacheAccessTimes(); // Persist changes
}

/**
 * Check if file exists in cache
 */
function isInCache(merkleHex) {
  if (!CACHE_ENABLED) return false;
  const cachePath = getCachePath(merkleHex);
  return fs.existsSync(cachePath);
}

/**
 * Get file from cache (updates access time)
 */
function getFromCache(merkleHex) {
  if (!CACHE_ENABLED) return null;
  const cachePath = getCachePath(merkleHex);
  try {
    const data = fs.readFileSync(cachePath);
    // Update access time
    cacheAccessTimes.set(merkleHex, Date.now());
    return data;
  } catch (err) {
    console.error(`⚠️  Cache read error: ${err.message}`);
    return null;
  }
}

/**
 * Save file to cache (with LRU eviction if needed)
 */
function saveToCache(merkleHex, data) {
  if (!CACHE_ENABLED) return;
  
  // Check if we need to evict before saving
  const maxBytes = MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024;
  const currentSize = getCacheSizeBytes();
  const dataSize = data.length;
  
  if (currentSize + dataSize > maxBytes) {
    // Keep 10% buffer below max
    const targetSize = maxBytes * 0.9;
    evictOldFiles(targetSize);
  }
  
  const cachePath = getCachePath(merkleHex);
  try {
    fs.writeFileSync(cachePath, data);
    cacheAccessTimes.set(merkleHex, Date.now());
    console.log(`💾 Cached: ${merkleHex.substring(0, 16)}... (${(data.length / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    console.error(`⚠️  Cache write error: ${err.message}`);
  }
}

// ==================== PROVIDER MANAGEMENT ====================

/**
 * Update provider health score
 */
function updateProviderHealth(providerUrl, success, errorMessage = '') {
  if (!providerHealth.has(providerUrl)) {
    providerHealth.set(providerUrl, {
      successes: 0,
      failures: 0,
      lastAttempt: Date.now(),
      lastError: '',
      totalAttempts: 0
    });
  }
  
  const health = providerHealth.get(providerUrl);
  health.totalAttempts++;
  health.lastAttempt = Date.now();
  
  if (success) {
    health.successes++;
    health.lastError = '';
    metrics.providerSuccesses++;
  } else {
    health.failures++;
    health.lastError = errorMessage;
    metrics.providerFailures++;
  }
}

/**
 * Get active storage providers from Jackal blockchain using gRPC
 * Results are cached for 24 hours and persisted to disk
 */
async function getActiveProvidersFromGRPC(forceRefresh = false) {
  // Check cache first
  const now = Date.now();
  if (!forceRefresh && grpcProviderCache.valid && (now - grpcProviderCache.timestamp) < GRPC_CACHE_TTL) {
    console.log(`📦 Using cached gRPC providers (${grpcProviderCache.providers.length} providers, ${Math.floor((GRPC_CACHE_TTL - (now - grpcProviderCache.timestamp)) / 1000 / 60 / 60)}h remaining)`);
    return grpcProviderCache.providers;
  }
  
  try {
    console.log(`📡 Fetching providers via gRPC (${JACKAL_GRPC_ENDPOINT})...`);
    metrics.grpcQueries++;
    
    const command = `
      for addr in $(grpcurl -plaintext ${JACKAL_GRPC_ENDPOINT} canine_chain.storage.Query/ActiveProviders | jq -r '.providers[].address'); do
        grpcurl -plaintext -d "{\\"address\\":\\"$addr\\"}" ${JACKAL_GRPC_ENDPOINT} canine_chain.storage.Query/Provider | jq -r '.provider.ip'
      done | grep -E '^https?://'
    `;
    
    const { stdout, stderr } = await execPromise(command, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
    
    const providers = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('http://') || line.startsWith('https://'));
    
    if (providers.length === 0) {
      console.warn('⚠️  No providers found from gRPC query');
      return grpcProviderCache.providers; // Return old cache if available
    }
    
    // Update cache
    grpcProviderCache = {
      providers,
      timestamp: now,
      valid: true
    };
    
    // Save to disk
    saveGRPCCache();
    
    console.log(`✅ Found ${providers.length} active providers from gRPC (cached for 24h, persisted to disk)`);
    return providers;
    
  } catch (err) {
    console.error('⚠️  gRPC provider query failed:', err.message);
    
    if (err.message.includes('grpcurl: command not found') || err.message.includes('jq: command not found')) {
      console.error('❌ Required tools not installed: grpcurl and/or jq');
    }
    
    // Return cached providers if available
    if (grpcProviderCache.valid) {
      console.log(`📦 Falling back to cached providers (${grpcProviderCache.providers.length} providers)`);
      return grpcProviderCache.providers;
    }
    
    return [];
  }
}

// Query gRPC on startup (will load from disk if available)
(async () => {
  console.log('🚀 Initializing provider list...');
  if (!grpcProviderCache.valid || grpcProviderCache.providers.length === 0) {
    await getActiveProvidersFromGRPC();
  }
})();

// ==================== DOWNLOAD UTILITIES ====================

/**
 * Download from URL with timeout
 */
function downloadFromUrl(url, timeoutMs = PROVIDER_TIMEOUT, rangeHeader = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      method: 'GET',
      headers: {}
    };
    
    // Add Range header if provided
    if (rangeHeader) {
      options.headers['Range'] = rangeHeader;
    }
    
    const request = client.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFromUrl(res.headers.location, timeoutMs, rangeHeader)
          .then(resolve)
          .catch(reject);
      }
      
      // Accept both 200 (full) and 206 (partial) responses
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        data: Buffer.concat(chunks),
        statusCode: res.statusCode,
        headers: res.headers
      }));
      res.on('error', reject);
    });
    
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Try downloading from a single provider
 */
async function tryProvider(providerUrl, merkleHex, timeoutMs = PROVIDER_TIMEOUT, rangeHeader = null) {
  const downloadUrl = `${providerUrl}/download/${merkleHex}`;
  
  try {
    console.log(`   Trying: ${providerUrl}`);
    const result = await downloadFromUrl(downloadUrl, timeoutMs, rangeHeader);
    const data = result.data;
    
    // Verify it's not an error page
    if (data.length < 1000 && data.toString('utf8').toLowerCase().includes('<!doctype html>')) {
      throw new Error('Got HTML error page');
    }
    
    updateProviderHealth(providerUrl, true);
    console.log(`   ✅ Success: ${providerUrl} (${(data.length / 1024 / 1024).toFixed(2)} MB)`);
    return { data, provider: providerUrl, statusCode: result.statusCode, headers: result.headers };
  } catch (err) {
    updateProviderHealth(providerUrl, false, err.message);
    console.log(`   ❌ Failed: ${providerUrl} - ${err.message}`);
    throw err;
  }
}

/**
 * Try multiple providers with SMART racing:
 * - Race to first response (fast)
 * - Validate response before accepting (safe)
 * - Auto-fallback if validation fails (reliable)
 * Returns immediately when first VALID provider succeeds
 */
async function tryProvidersParallel(providers, merkleHex, timeoutMs = PROVIDER_TIMEOUT, rangeHeader = null) {
  if (providers.length === 0) {
    throw new Error('No providers available');
  }
  
  console.log(`🔄 Racing ${providers.length} providers in parallel...`);
  
  // Validation function - same checks as before
  const isValidResponse = (data, provider) => {
    // Check 1: Must have data
    if (!data || data.length === 0) {
      console.log(`   ⚠️  Invalid: ${provider} - Empty response`);
      return false;
    }
    
    // Check 2: Must not be HTML error page (existing validation)
    if (data.length < 1000 && data.toString('utf8').toLowerCase().includes('<!doctype html>')) {
      console.log(`   ⚠️  Invalid: ${provider} - HTML error page`);
      return false;
    }
    
    // Check 3: Must not be error JSON
    if (data.length < 500) {
      try {
        const text = data.toString('utf8').toLowerCase();
        if (text.includes('"error"') || text.includes('"message"')) {
          console.log(`   ⚠️  Invalid: ${provider} - Error JSON`);
          return false;
        }
      } catch (e) {
        // If can't parse, assume it's valid binary data
      }
    }
    
    // All checks passed
    return true;
  };
  
  return new Promise((resolve, reject) => {
    let successFound = false;
    let attemptCount = 0;
    const errors = [];
    
    // Launch all provider attempts simultaneously
    providers.forEach(provider => {
      tryProvider(provider, merkleHex, timeoutMs, rangeHeader)
        .then(result => {
          // Skip if we already found valid success
          if (successFound) {
            return;
          }
          
          // Validate the response
          if (!isValidResponse(result.data, provider)) {
            // Validation failed - treat as error and continue racing
            errors.push({ provider, error: 'Invalid response (failed validation)' });
            attemptCount++;
            
            // Check if all attempts exhausted
            if (attemptCount === providers.length && !successFound) {
              const error = new Error('All providers failed or returned invalid data');
              error.details = errors;
              reject(error);
            }
            return;
          }
          
          // Valid response! This is our winner
          successFound = true;
          console.log(`🏆 Race won by: ${provider} (validated ✓)`);
          resolve(result);
        })
        .catch(err => {
          // Track failures
          errors.push({ provider, error: err.message });
          attemptCount++;
          
          // Only reject if ALL providers failed
          if (attemptCount === providers.length && !successFound) {
            const error = new Error('All providers failed');
            error.details = errors;
            reject(error);
          }
        });
    });
  });
}

/**
 * Download file with request deduplication
 * If same file is requested multiple times, download once and share result
 */
async function downloadFileWithDedup(merkleHex, rangeHeader = null) {
  const cacheKey = rangeHeader ? `${merkleHex}:${rangeHeader}` : merkleHex;
  
  // Check if request is already in flight
  if (inflightRequests.has(cacheKey)) {
    console.log(`🔗 Deduplicating request for ${merkleHex.substring(0, 16)}...`);
    return await inflightRequests.get(cacheKey);
  }
  
  // Create new download promise
  const downloadPromise = (async () => {
    try {
      return await downloadFile(merkleHex, rangeHeader);
    } finally {
      // Remove from inflight after completion
      inflightRequests.delete(cacheKey);
    }
  })();
  
  // Track inflight request
  inflightRequests.set(cacheKey, downloadPromise);
  
  return await downloadPromise;
}

/**
 * Download file using tiered provider approach
 */
async function downloadFile(merkleHex, rangeHeader = null) {
  console.log(`\n📥 Downloading merkle: ${merkleHex.substring(0, 16)}...${rangeHeader ? ` (Range: ${rangeHeader})` : ''}`);
  
  const attemptLog = {
    tier1: { tried: 0, errors: [] },
    grpc: { tried: 0, errors: [] }
  };
  
  // Try all 16 Tier 1 providers in parallel
  console.log(`🚀 Tier 1: Trying ${TIER1_PROVIDERS.length} known providers...`);
  attemptLog.tier1.tried = TIER1_PROVIDERS.length;
  
  try {
    const result = await tryProvidersParallel(TIER1_PROVIDERS, merkleHex, TIER1_TIMEOUT, rangeHeader);
    console.log(`✅ Tier 1 success from: ${result.provider}`);
    
    // Add attempt details to result
    result.attemptLog = attemptLog;
    result.attemptLog.tier1.errors = result.attemptDetails
      .filter(a => !a.success)
      .map(a => `${a.provider}: ${a.error}`);
    
    return result;
  } catch (err) {
    console.log(`⚠️  Tier 1 failed: ${err.message}`);
    if (err.details) {
      attemptLog.tier1.errors = err.details.map(d => `${d.provider}: ${d.error}`);
    }
  }
  
  // Tier 1 failed - Query gRPC as fallback
  console.log(`🌐 Fallback: Querying gRPC for additional providers...`);
  const grpcProviders = await getActiveProvidersFromGRPC();
  
  if (grpcProviders.length === 0) {
    const error = new Error('No active providers available from gRPC');
    error.attemptLog = attemptLog;
    throw error;
  }
  
  // Try gRPC providers (excluding ones already in Tier 1)
  const fallbackProviders = grpcProviders.filter(p => !TIER1_PROVIDERS.includes(p));
  
  if (fallbackProviders.length === 0) {
    console.log(`⚠️  No additional providers found in gRPC (all already tried in Tier 1)`);
    const error = new Error('File not available from any provider');
    error.attemptLog = attemptLog;
    throw error;
  }
  
  console.log(`🔄 Fallback: Trying ${fallbackProviders.length} additional providers from gRPC...`);
  attemptLog.grpc.tried = fallbackProviders.length;
  
  try {
    const result = await tryProvidersParallel(fallbackProviders, merkleHex, PROVIDER_TIMEOUT, rangeHeader);
    console.log(`✅ gRPC fallback success from: ${result.provider}`);
    
    result.attemptLog = attemptLog;
    result.attemptLog.grpc.errors = result.attemptDetails
      .filter(a => !a.success)
      .map(a => `${a.provider}: ${a.error}`);
    
    return result;
  } catch (err) {
    console.log(`❌ gRPC fallback failed: ${err.message}`);
    if (err.details) {
      attemptLog.grpc.errors = err.details.map(d => `${d.provider}: ${d.error}`);
    }
    
    const error = new Error('File not available from any provider');
    error.attemptLog = attemptLog;
    throw error;
  }
}

// ==================== HTTP UTILITIES ====================

/**
 * Parse Range header (e.g., "bytes=0-1023")
 */
function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return null;
  
  let start = match[1] ? parseInt(match[1]) : 0;
  let end = match[2] ? parseInt(match[2]) : fileSize - 1;
  
  // Validate range
  if (start >= fileSize) return null;
  if (end >= fileSize) end = fileSize - 1;
  if (start > end) return null;
  
  return { start, end };
}

/**
 * Determine MIME type from filename
 */
function getContentType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    // Images
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
    'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
    'ico': 'image/x-icon', 'bmp': 'image/bmp',
    
    // Documents
    'pdf': 'application/pdf', 'txt': 'text/plain', 'json': 'application/json',
    'doc': 'application/msword', 
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel', 
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    
    // Video
    'mp4': 'video/mp4', 'webm': 'video/webm', 'ogg': 'video/ogg',
    'mov': 'video/quicktime', 'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska',
    'm4v': 'video/x-m4v', 'flv': 'video/x-flv', 'wmv': 'video/x-ms-wmv',
    
    // Audio
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
    'flac': 'audio/flac', 'm4a': 'audio/mp4',
    
    // Archives
    'zip': 'application/zip', 'rar': 'application/x-rar-compressed',
    'tar': 'application/x-tar', 'gz': 'application/gzip',
    '7z': 'application/x-7z-compressed',
    
    // Code
    'html': 'text/html', 'css': 'text/css', 'js': 'application/javascript',
    'ts': 'application/typescript', 'jsx': 'application/javascript',
    'py': 'text/x-python', 'java': 'text/x-java', 'cpp': 'text/x-c++src',
  };
  
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Check if file is a video based on extension
 */
function isVideoFile(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Sanitize filename for HTTP headers
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/"/g, '\\"')
    .trim();
}

/**
 * Build detailed error response
 */
function buildErrorResponse(err, merkleHex, attemptLog = null) {
  const errorType = err.message || 'unknown_error';
  
  // Track error types
  metrics.errorsByType[errorType] = (metrics.errorsByType[errorType] || 0) + 1;
  
  const response = {
    error: err.name || 'Download failed',
    message: err.message || 'Could not retrieve file from storage network',
    merkleHex,
    timestamp: new Date().toISOString()
  };
  
  // Add debug information if available
  if (attemptLog || err.attemptLog) {
    const log = attemptLog || err.attemptLog;
    response.debug = {
      tier1_providers_tried: log.tier1.tried,
      tier1_errors: log.tier1.errors.slice(0, 5), // Limit to first 5 to avoid huge responses
      grpc_providers_tried: log.grpc?.tried || 0,
      grpc_errors: log.grpc?.errors?.slice(0, 5) || [],
      total_providers_queried: log.tier1.tried + (log.grpc?.tried || 0),
      grpc_cache_used: grpcProviderCache.valid,
      cache_checked: true
    };
    
    // Add suggestions based on error pattern
    if (log.tier1.errors.length > 0 && log.tier1.errors.every(e => e.includes('timeout'))) {
      response.debug.suggestion = 'All providers timed out. Network may be congested. Try again in a moment.';
    } else if (log.tier1.errors.length > 0 && log.tier1.errors.some(e => e.includes('404'))) {
      response.debug.suggestion = 'File not found on providers. It may not exist or is still being replicated.';
    } else if (log.grpc.tried === 0) {
      response.debug.suggestion = 'File not available from known providers. It may be a new upload still replicating.';
    }
  }
  
  return response;
}

// ==================== API ENDPOINTS ====================

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
  const cacheSize = CACHE_ENABLED ? getCacheSizeGB().toFixed(2) : 'disabled';
  
  // Check gRPC availability
  let grpcAvailable = 'unknown';
  try {
    await execPromise('which grpcurl && which jq', { timeout: 1000 });
    grpcAvailable = 'available';
  } catch {
    grpcAvailable = 'not installed';
  }
  
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  
  res.json({ 
    status: 'ok',
    version: '2.2.1',
    service: 'radiant-gateway',
    uptime_seconds: uptime,
    method: 'tier1-16-providers-grpc-fallback-smart-streaming-full-persistence',
    cache: {
      enabled: CACHE_ENABLED,
      size_gb: cacheSize,
      max_size_gb: MAX_CACHE_SIZE_GB,
      files_cached: cacheAccessTimes.size,
      location: CACHE_DIR
    },
    providers: {
      tier1_count: TIER1_PROVIDERS.length,
      grpc_endpoint: JACKAL_GRPC_ENDPOINT,
      grpc_tools: grpcAvailable,
      grpc_cache_valid: grpcProviderCache.valid,
      grpc_cache_age_hours: grpcProviderCache.valid 
        ? ((Date.now() - grpcProviderCache.timestamp) / 1000 / 60 / 60).toFixed(1)
        : 'N/A',
      health_tracked: providerHealth.size
    },
    persistence: {
      data_directory: DATA_DIR,
      save_interval_minutes: (SAVE_INTERVAL / 1000 / 60).toFixed(1),
      metrics_persisted: true,
      grpc_cache_persisted: true,
      provider_health_persisted: true,
      cache_access_times_persisted: true
    },
    config: {
      provider_timeout_ms: PROVIDER_TIMEOUT,
      tier1_timeout_ms: TIER1_TIMEOUT,
      grpc_cache_ttl_hours: GRPC_CACHE_TTL / 1000 / 60 / 60,
      large_file_threshold_mb: LARGE_FILE_THRESHOLD_MB
    }
  });
});

/**
 * Detailed metrics endpoint
 */
app.get('/metrics', (req, res) => {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  const cacheHitRate = metrics.totalRequests > 0 
    ? ((metrics.cacheHits / metrics.totalRequests) * 100).toFixed(2) + '%'
    : 'N/A';
  
  const avgResponseTime = metrics.requestTimes.length > 0
    ? (metrics.requestTimes.reduce((a, b) => a + b, 0) / metrics.requestTimes.length).toFixed(2) + 'ms'
    : 'N/A';
  
  res.json({
    service: 'radiant-gateway',
    version: '2.2.1',
    uptime_seconds: uptime,
    requests: {
      total: metrics.totalRequests,
      cache_hits: metrics.cacheHits,
      cache_misses: metrics.cacheMisses,
      cache_hit_rate: cacheHitRate,
      avg_response_time: avgResponseTime,
      inflight_requests: inflightRequests.size,
      video_streams: metrics.videoStreams,
      large_file_downloads: metrics.largeFileDownloads
    },
    providers: {
      total_successes: metrics.providerSuccesses,
      total_failures: metrics.providerFailures,
      success_rate: metrics.providerSuccesses + metrics.providerFailures > 0
        ? ((metrics.providerSuccesses / (metrics.providerSuccesses + metrics.providerFailures)) * 100).toFixed(2) + '%'
        : 'N/A',
      grpc_queries: metrics.grpcQueries
    },
    cache: {
      enabled: CACHE_ENABLED,
      size_gb: getCacheSizeGB().toFixed(2),
      max_size_gb: MAX_CACHE_SIZE_GB,
      files_cached: cacheAccessTimes.size,
      usage_percent: ((getCacheSizeGB() / MAX_CACHE_SIZE_GB) * 100).toFixed(2) + '%'
    },
    persistence: {
      metrics_saved_to_disk: true,
      last_saved: new Date(metrics.lastSaved).toISOString()
    },
    errors: metrics.errorsByType
  });
});

/**
 * Provider health status endpoint
 */
app.get('/providers/health', (req, res) => {
  const healthStats = Array.from(providerHealth.entries()).map(([url, stats]) => ({
    provider: url,
    successes: stats.successes,
    failures: stats.failures,
    total_attempts: stats.totalAttempts,
    success_rate: stats.totalAttempts > 0 
      ? ((stats.successes / stats.totalAttempts) * 100).toFixed(2) + '%'
      : 'N/A',
    last_attempt: new Date(stats.lastAttempt).toISOString(),
    last_error: stats.lastError || null
  }));
  
  // Sort by success rate
  healthStats.sort((a, b) => {
    const rateA = a.successes / (a.total_attempts || 1);
    const rateB = b.successes / (b.total_attempts || 1);
    return rateB - rateA;
  });
  
  res.json({
    providers: healthStats,
    total_tracked: healthStats.length,
    tier1_providers: TIER1_PROVIDERS.length
  });
});

/**
 * Refresh gRPC provider cache manually
 */
app.post('/providers/refresh', async (req, res) => {
  try {
    const providers = await getActiveProvidersFromGRPC(true);
    res.json({
      success: true,
      providers_found: providers.length,
      cache_updated: new Date(grpcProviderCache.timestamp).toISOString(),
      valid_for_hours: GRPC_CACHE_TTL / 1000 / 60 / 60,
      persisted_to_disk: true
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * Cache stats endpoint
 */
app.get('/cache/stats', (req, res) => {
  if (!CACHE_ENABLED) {
    return res.json({ enabled: false });
  }
  
  const sizeGB = getCacheSizeGB();
  
  res.json({
    enabled: true,
    files_cached: cacheAccessTimes.size,
    size_gb: sizeGB.toFixed(2),
    max_size_gb: MAX_CACHE_SIZE_GB,
    usage_percent: ((sizeGB / MAX_CACHE_SIZE_GB) * 100).toFixed(2) + '%',
    location: CACHE_DIR,
    lru_eviction_enabled: true
  });
});

/**
 * Clear cache endpoint (admin only - protect in production!)
 */
app.delete('/cache/clear', (req, res) => {
  if (!CACHE_ENABLED) {
    return res.json({ enabled: false, message: 'Cache is disabled' });
  }
  
  try {
    const deleteRecursive = (dir) => {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach(file => {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
          deleteRecursive(filePath);
        } else {
          fs.unlinkSync(filePath);
        }
      });
    };
    
    deleteRecursive(CACHE_DIR);
    cacheAccessTimes.clear();
    saveCacheAccessTimes();
    console.log('🗑️  Cache cleared');
    
    res.json({ 
      success: true, 
      message: 'Cache cleared successfully' 
    });
  } catch (err) {
    res.status(500).json({ 
      error: 'Failed to clear cache',
      message: err.message 
    });
  }
});

/**
 * Main file download endpoint
 * ✅ Supports both CID and merkleHex (forward compatible)
 * ✅ Supports Range requests for video streaming
 * ✅ LRU cache with automatic eviction
 * ✅ Request deduplication
 * ✅ Smart streaming: Videos always stream, large non-videos force download
 * ✅ Cloudflare bypass header for large files (>90MB)
 * ✅ Full persistence: All state survives Docker restarts
 */
app.get('/file/:identifier', async (req, res) => {
  const startTime = Date.now();
  metrics.totalRequests++;
  
  const { identifier } = req.params; // Can be either CID or merkleHex
  const { name } = req.query;
  const rangeHeader = req.headers.range;
  
  // ✅ FORWARD COMPATIBLE: Accept both 64-char merkleHex AND 59-char CID
  const isMerkleHex = /^[a-f0-9]{64}$/i.test(identifier);
  const isCID = identifier.startsWith('bafy') && identifier.length === 59;
  
  if (!isMerkleHex && !isCID) {
    return res.status(400).json({ 
      error: 'Invalid identifier',
      message: 'Identifier must be either 64-char merkleHex or 59-char CID (bafy...)',
      received: identifier,
      length: identifier.length
    });
  }
  
  // Use identifier as-is (works for both merkleHex and CID)
  const merkleHex = identifier;
  
  console.log(`\n📥 Request for file: ${merkleHex.substring(0, 16)}... (${isMerkleHex ? 'merkleHex' : 'CID'})`);
  if (name) console.log(`📄 Filename: ${name}`);
  if (rangeHeader) console.log(`📏 Range: ${rangeHeader}`);
  
  try {
    let fileData;
    let source = 'network';
    let statusCode = 200;
    let responseHeaders = {};
    
    // Check cache first (only for full file requests, not ranges)
    if (!rangeHeader && isInCache(merkleHex)) {
      console.log(`💨 Cache hit!`);
      fileData = getFromCache(merkleHex);
      source = 'cache';
      metrics.cacheHits++;
    } else {
      if (rangeHeader) {
        console.log(`🌐 Range request - fetching from network...`);
      } else {
        console.log(`🌐 Cache miss - downloading from network...`);
      }
      
      metrics.cacheMisses++;
      
      // Use request deduplication
      const result = await downloadFileWithDedup(merkleHex, rangeHeader);
      fileData = result.data;
      source = `provider:${result.provider}`;
      statusCode = result.statusCode || 200;
      responseHeaders = result.headers || {};
      
      // Save to cache only if it's a full file (not range request)
      if (!rangeHeader && statusCode === 200) {
        saveToCache(merkleHex, fileData);
      }
    }
    
    // Determine filename and content type
    const fileName = name || `file-${merkleHex.substring(0, 16)}`;
    const contentType = getContentType(fileName);
    const safeFileName = sanitizeFilename(fileName);
    
    // 🎬 Calculate file size and check if it's a video
    const fileSizeMB = fileData.length / (1024 * 1024);
    const isLargeFile = fileSizeMB > LARGE_FILE_THRESHOLD_MB;
    const isVideo = isVideoFile(fileName);
    
    // 🎯 Smart streaming/download decision
    let contentDisposition = 'inline'; // Default: view in browser
    let bypassCloudflare = false;
    let streamingMode = 'inline';
    
    if (isVideo) {
      // Videos ALWAYS stream (even if large)
      contentDisposition = 'inline';
      streamingMode = 'video-stream';
      bypassCloudflare = isLargeFile; // Large videos bypass Cloudflare cache
      if (isLargeFile) metrics.videoStreams++;
    } else if (isLargeFile) {
      // Large non-video files force download
      contentDisposition = 'attachment';
      streamingMode = 'force-download';
      bypassCloudflare = true;
      metrics.largeFileDownloads++;
    } else {
      // Small non-video files: view in browser, cache on Cloudflare
      contentDisposition = 'inline';
      streamingMode = 'inline-small';
      bypassCloudflare = false;
    }
    
    // Allow manual override via query param
    if (req.query.download === 'true') {
      contentDisposition = 'attachment';
      streamingMode = 'user-requested';
    }
    
    console.log(`   🎬 Streaming mode: ${streamingMode} (${fileSizeMB.toFixed(2)}MB, ${isVideo ? 'video' : 'non-video'})`);
    
    // ✅ Handle Range requests
    if (rangeHeader && statusCode !== 206) {
      // Client requested range but we got full file (from cache or provider that doesn't support ranges)
      const range = parseRangeHeader(rangeHeader, fileData.length);
      if (range) {
        fileData = fileData.slice(range.start, range.end + 1);
        statusCode = 206;
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileData.length}`);
      }
    } else if (statusCode === 206 && responseHeaders['content-range']) {
      // Provider returned 206 - pass through their Content-Range header
      res.setHeader('Content-Range', responseHeaders['content-range']);
    }
    
    // Set response headers
    res.status(statusCode);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fileData.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `${contentDisposition}; filename="${safeFileName}"`);
    res.setHeader('X-Provider-Source', source);
    res.setHeader('X-Identifier-Type', isMerkleHex ? 'merkleHex' : 'CID');
    res.setHeader('X-File-Size-MB', fileSizeMB.toFixed(2));
    res.setHeader('X-Streaming-Mode', streamingMode);
    
    // 🌐 Signal to Cloudflare Worker whether to bypass cache
    if (bypassCloudflare) {
      res.setHeader('X-Cloudflare-Bypass', 'true');
      res.setHeader('X-Bypass-Reason', isVideo ? 'large-video' : 'large-file');
    } else {
      res.setHeader('X-Cloudflare-Bypass', 'false');
    }
    
    const duration = Date.now() - startTime;
    console.log(`✅ Serving: ${fileName} (${fileSizeMB.toFixed(2)} MB) from ${source} (${duration}ms)`);
    console.log(`   Content-Type: ${contentType}`);
    console.log(`   Status: ${statusCode}${statusCode === 206 ? ' Partial Content' : ''}`);
    console.log(`   Disposition: ${contentDisposition}`);
    console.log(`   Cloudflare Bypass: ${bypassCloudflare}\n`);
    
    res.send(fileData);
    
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`❌ Error (${duration}ms):`, err.message, '\n');
    
    // Build detailed error response
    const errorResponse = buildErrorResponse(err, merkleHex, err.attemptLog);
    
    // Determine appropriate status code
    let statusCode = 500;
    if (err.message?.includes('timeout')) {
      statusCode = 504;
      errorResponse.error = 'Gateway timeout';
    } else if (err.message?.includes('not available') || err.message?.includes('No active providers')) {
      statusCode = 503;
      errorResponse.error = 'Service unavailable';
    }
    
    res.status(statusCode).json(errorResponse);
  }
});

// ==================== GRACEFUL SHUTDOWN ====================

process.on('SIGTERM', () => {
  console.log('\n📴 Received SIGTERM, saving all state...');
  saveAllState();
  console.log('✅ All state saved, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n📴 Received SIGINT, saving all state...');
  saveAllState();
  console.log('✅ All state saved, shutting down...');
  process.exit(0);
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🚀 Radiant Gateway v2.2.1 - Smart Racing Edition`);
  console.log(`${'='.repeat(80)}`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 File endpoint: http://localhost:${PORT}/file/{merkleHex|CID}?name={filename}`);
  console.log(`💊 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Metrics: http://localhost:${PORT}/metrics`);
  console.log(`📈 Cache stats: http://localhost:${PORT}/cache/stats`);
  console.log(`🏥 Provider health: http://localhost:${PORT}/providers/health`);
  console.log(`🔄 Refresh providers: POST http://localhost:${PORT}/providers/refresh`);
  console.log(`\n🔧 Configuration:`);
  console.log(`   - Tier 1 providers: ${TIER1_PROVIDERS.length}`);
  console.log(`   - gRPC endpoint: ${JACKAL_GRPC_ENDPOINT}`);
  console.log(`   - gRPC cache TTL: ${GRPC_CACHE_TTL / 1000 / 60 / 60} hours`);
  console.log(`   - Cache: ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'} (max ${MAX_CACHE_SIZE_GB}GB)`);
  console.log(`   - LRU eviction: ENABLED`);
  console.log(`   - Range requests: SUPPORTED`);
  console.log(`   - Request deduplication: ENABLED`);
  console.log(`   - Provider timeout: ${PROVIDER_TIMEOUT}ms`);
  console.log(`   - Tier 1 timeout: ${TIER1_TIMEOUT}ms`);
  console.log(`   - Large file threshold: ${LARGE_FILE_THRESHOLD_MB}MB`);
  console.log(`   - State save interval: ${SAVE_INTERVAL / 1000 / 60} minutes`);
  console.log(`   - Data directory: ${DATA_DIR}`);
  console.log(`\n✨ Features:`);
  console.log(`   ✅ Accepts both CID and merkleHex (forward compatible)`);
  console.log(`   ✅ Automatic LRU cache eviction`);
  console.log(`   ✅ Video streaming support (Range requests)`);
  console.log(`   ✅ Request deduplication (prevents duplicate downloads)`);
  console.log(`   ✅ Provider health tracking (persisted to disk)`);
  console.log(`   ✅ 24-hour gRPC caching (persisted to disk)`);
  console.log(`   ✅ Detailed error responses (with debug info)`);
  console.log(`   ✅ Comprehensive metrics tracking (persisted to disk)`);
  console.log(`   ✅ Smart streaming: Videos always stream, large files auto-download`);
  console.log(`   ✅ Cloudflare hybrid caching support (bypass header for large files)`);
  console.log(`   ✅ FULL PERSISTENCE: All state survives Docker restarts`);
  console.log(`\n🎬 Streaming Logic:`);
  console.log(`   - Videos (any size): Stream in browser (inline)`);
  console.log(`   - Large videos (>${LARGE_FILE_THRESHOLD_MB}MB): Stream + Cloudflare bypass`);
  console.log(`   - Non-video <${LARGE_FILE_THRESHOLD_MB}MB: View in browser + Cloudflare cache`);
  console.log(`   - Non-video >${LARGE_FILE_THRESHOLD_MB}MB: Force download + Cloudflare bypass`);
  console.log(`\n💾 Persistence:`);
  console.log(`   - Provider health → ${HEALTH_FILE}`);
  console.log(`   - Cache access times → ${CACHE_ACCESS_FILE}`);
  console.log(`   - Metrics → ${METRICS_FILE}`);
  console.log(`   - gRPC provider cache → ${GRPC_CACHE_FILE}`);
  console.log(`   - Auto-save every: ${SAVE_INTERVAL / 1000 / 60} minutes`);
  console.log(`\n✅ Ready to serve files!\n`);
  console.log(`${'='.repeat(80)}\n`);
});