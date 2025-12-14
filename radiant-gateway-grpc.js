// radiant-gateway-grpc.js v3.0.1-findfile - FindFile Edition (BASE64 FIX)
// Routes Jackal merkle hashes through storage provider network
// ✅ LRU cache eviction, Range requests, Request deduplication, Health persistence
// ✅ 16-provider Tier 1, 24hr gRPC caching, Detailed error responses
// ✅ Smart streaming: Videos always stream, large non-videos force download
// ✅ Cloudflare hybrid: Small files cached, large files bypass
// ✅ FULL PERSISTENCE: Metrics, gRPC cache, and all state persists across restarts
// 🎯 NEW v3.0.1: FindFile() gRPC query - targets specific providers that have each file

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
const VERSION = '3.0.1-findfile';

// 🎯 NEW: FindFile configuration
const USE_FINDFILE = process.env.USE_FINDFILE !== 'false'; // Enable FindFile optimization
const FINDFILE_TIMEOUT = parseInt(process.env.FINDFILE_TIMEOUT || '3000'); // FindFile query timeout
const FINDFILE_CACHE_TTL = 3600000; // 1 hour cache for FindFile results

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
const CACHE_DIR = path.join(DATA_DIR, 'cache');

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
const FINDFILE_CACHE_FILE = path.join(DATA_DIR, 'findfile-cache.json'); // 🎯 NEW

// ==================== RUNTIME STATE ====================

// Provider health tracking
const providerHealth = new Map();

// ✅ LRU Cache tracking
const cacheAccessTimes = new Map(); // merkleHex -> timestamp

// ✅ Request deduplication tracking (in-memory only - intentionally not persisted)
const inflightRequests = new Map(); // merkleHex -> Promise

// 🎯 NEW: FindFile cache (merkleHex -> provider URLs)
const findFileCache = new Map(); // merkleHex -> {providers: [], timestamp}

// ✅ gRPC provider cache
let grpcProviderCache = {
  providers: [],
  timestamp: 0,
  valid: false
};

// ✅ Track active streams to protect from eviction
const activeStreams = new Set(); // merkleHex values

// ✅ Cache size tracker (kept in sync without request-time scans)
let cacheSizeBytes = 0;

// ✅ Metrics tracking (now persistent!)
let metrics = {
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  providerSuccesses: 0,
  providerFailures: 0,
  grpcQueries: 0,
  findFileQueries: 0,    // 🎯 NEW
  findFileHits: 0,       // 🎯 NEW  
  findFileFallbacks: 0,  // 🎯 NEW
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
 * 🎯 Load FindFile cache from disk
 */
function loadFindFileCache() {
  try {
    if (fs.existsSync(FINDFILE_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(FINDFILE_CACHE_FILE, 'utf8'));
      Object.entries(data).forEach(([hash, entry]) => {
        findFileCache.set(hash, entry);
      });
      console.log(`✅ Loaded FindFile cache for ${findFileCache.size} files`);
    }
  } catch (err) {
    console.warn('⚠️  Could not load FindFile cache:', err.message);
  }
}

/**
 * 🎯 Save FindFile cache to disk
 */
function saveFindFileCache() {
  try {
    const data = Object.fromEntries(findFileCache);
    fs.writeFileSync(FINDFILE_CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('❌ Could not save FindFile cache:', err.message);
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
  saveFindFileCache(); // 🎯 NEW
}

// ==================== INITIALIZATION ====================

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
loadFindFileCache(); // 🎯 NEW

// Initialize cache size counter once at startup
calculateInitialCacheSize();

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
 * Compute cache size once at startup (recursive scan)
 */
function calculateInitialCacheSize() {
  if (!CACHE_ENABLED || !fs.existsSync(CACHE_DIR)) {
    cacheSizeBytes = 0;
    return;
  }

  let totalSize = 0;
  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        scanDir(filePath);
      } else {
        totalSize += stats.size;
      }
    });
  };

  scanDir(CACHE_DIR);
  cacheSizeBytes = totalSize;
  console.log(`📦 Cache size initialized: ${(cacheSizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`);
}

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
  return cacheSizeBytes;
}

/**
 * Get current cache size in GB
 */
function getCacheSizeGB() {
  return getCacheSizeBytes() / (1024 * 1024 * 1024);
}

/**
 * Evict old files to free up space (LRU eviction)
 */
function evictOldFiles(targetSizeBytes) {
  const currentSize = getCacheSizeBytes();
  if (currentSize <= targetSizeBytes) return;
  
  const needToFree = currentSize - targetSizeBytes;
  let freed = 0;
  console.log(`🗑️  LRU Eviction: Need to free ${(needToFree / 1024 / 1024).toFixed(2)} MB`);

  const entriesByAge = Array.from(cacheAccessTimes.entries()).sort((a, b) => a[1] - b[1]);

  for (const [merkleHex] of entriesByAge) {
    if (freed >= needToFree) break;

    if (activeStreams.has(merkleHex)) {
      console.log(`   ⏩ Skipping active stream during eviction: ${merkleHex.substring(0, 16)}...`);
      continue;
    }

    const cachePath = getCachePath(merkleHex);
    try {
      const stats = fs.statSync(cachePath);
      fs.unlinkSync(cachePath);
      cacheAccessTimes.delete(merkleHex);
      freed += stats.size;
      cacheSizeBytes = Math.max(0, cacheSizeBytes - stats.size);
      console.log(`   Deleted: ${merkleHex.substring(0, 16)}... (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    } catch (err) {
      console.error(`   Failed to delete ${merkleHex}:`, err.message);
      cacheAccessTimes.delete(merkleHex);
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
function downloadFromUrl(url, destPath, timeoutMs = PROVIDER_TIMEOUT, abortSignal = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      if (err) {
        try {
          if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
          }
        } catch (cleanupErr) {
          console.warn(`⚠️  Temp cleanup failed for ${destPath}: ${cleanupErr.message}`);
        }
        return reject(err);
      }
      return resolve(data);
    };

    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      method: 'GET',
      headers: {}
    };
    
    if (abortSignal) {
      options.signal = abortSignal;
      if (abortSignal.aborted) {
        return finish(new Error('Download aborted'));
      }
    }
    
    const request = client.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        return downloadFromUrl(res.headers.location, destPath, timeoutMs, abortSignal)
          .then(data => finish(null, data))
          .catch(err => finish(err));
      }
      
      // Providers must only return full responses
      if (res.statusCode !== 200) {
        res.resume();
        return finish(new Error(`HTTP ${res.statusCode}`));
      }
      
      const expectedLengthHeader = res.headers['content-length'];
      const expectedLength = expectedLengthHeader ? parseInt(expectedLengthHeader, 10) : null;

      const tempStream = fs.createWriteStream(destPath);
      const validationChunks = [];
      const MAX_VALIDATION_BYTES = 1024 * 1024; // Bound validation memory
      let validationCollected = 0;
      let bytesWritten = 0;

      res.on('data', chunk => {
        bytesWritten += chunk.length;
        if (validationCollected < MAX_VALIDATION_BYTES) {
          const take = Math.min(chunk.length, MAX_VALIDATION_BYTES - validationCollected);
          validationChunks.push(chunk.slice(0, take));
          validationCollected += take;
        }
      });

      const onStreamError = (err) => {
        tempStream.destroy();
        res.destroy();
        finish(err);
      };

      res.on('error', onStreamError);
      tempStream.on('error', onStreamError);

      tempStream.on('finish', () => {
        if (Number.isFinite(expectedLength) && bytesWritten !== expectedLength) {
          return finish(new Error('Incomplete download from provider'));
        }
        finish(null, {
          tempPath: destPath,
          headers: res.headers,
          bytesWritten,
          validationBuffer: Buffer.concat(validationChunks)
        });
      });

      res.pipe(tempStream);
    });
    
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        request.destroy(new Error('Download aborted'));
        finish(new Error('Download aborted'));
      }, { once: true });
    }

    request.on('error', finish);
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(new Error('Request timeout'));
    });
  });
}

/**
 * Basic response validation using a bounded sample buffer
 */
function isValidResponseSample(validationBuffer, bytesWritten) {
  if (!bytesWritten || bytesWritten === 0) {
    return false;
  }

  if (!validationBuffer || validationBuffer.length === 0) {
    return true;
  }

  try {
    const text = validationBuffer.toString('utf8').toLowerCase();
    if (text.includes('<!doctype html>')) {
      return false;
    }
    if (text.includes('"error"') || text.includes('"message"')) {
      return false;
    }
  } catch (e) {
    // If decoding fails, assume binary data (valid)
  }

  return true;
}

/**
 * Try downloading from a single provider
 */
async function tryProvider(providerUrl, merkleHex, timeoutMs = PROVIDER_TIMEOUT, abortSignal = null, tempPathOverride = null) {
  const downloadUrl = `${providerUrl}/download/${merkleHex}`;
  const cachePath = getCachePath(merkleHex);
  const tempPath = tempPathOverride || `${cachePath}.partial.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const cleanupTemp = () => {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (err) {
      console.warn(`⚠️  Temp cleanup failed for ${tempPath}: ${err.message}`);
    }
  };
  
  try {
    console.log(`   Trying: ${providerUrl}`);
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    const result = await downloadFromUrl(downloadUrl, tempPath, timeoutMs, abortSignal);
    
    if (abortSignal?.aborted) {
      cleanupTemp();
      throw new Error('Download aborted');
    }
    
    if (!isValidResponseSample(result.validationBuffer, result.bytesWritten)) {
      cleanupTemp();
      throw new Error('Invalid response (failed validation)');
    }
    
    updateProviderHealth(providerUrl, true);
    console.log(`   ✅ Success: ${providerUrl} (${(result.bytesWritten / 1024 / 1024).toFixed(2)} MB)`);
    return { 
      provider: providerUrl, 
      tempPath, 
      statusCode: 200, 
      headers: result.headers,
      bytesWritten: result.bytesWritten
    };
  } catch (err) {
    if (abortSignal?.aborted && err.message === 'Download aborted') {
      console.log(`   ⏹️  Aborted: ${providerUrl} - ${err.message}`);
    } else {
      updateProviderHealth(providerUrl, false, err.message);
      console.log(`   ❌ Failed: ${providerUrl} - ${err.message}`);
    }
    cleanupTemp();
    throw err;
  }
}

/**
 * Try multiple providers in batched parallel mode (3 at a time):
 * - Race providers within each batch
 * - Move to next batch only if current batch fully fails
 * - Stop immediately when the first provider delivers a valid full file
 */
async function tryProvidersParallel(providers, merkleHex, timeoutMs = PROVIDER_TIMEOUT) {
  if (providers.length === 0) {
    throw new Error('No providers available');
  }
  
  console.log(`🔄 Racing ${providers.length} providers in parallel (batched)...`);
  const errors = [];
  const attemptDetails = [];
  const cachePath = getCachePath(merkleHex);
  
  for (let i = 0; i < providers.length; i += 3) {
    const batch = providers.slice(i, i + 3);
    console.log(`🔄 Trying provider batch ${Math.floor(i / 3) + 1} (${batch.length})...`);

    const controllers = batch.map(() => new AbortController());
    const batchPromises = batch.map((provider, idx) => 
      tryProvider(
        provider,
        merkleHex,
        timeoutMs,
        controllers[idx].signal,
        `${cachePath}.partial.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
      )
        .then(result => ({ ...result, providerIndex: idx }))
    );

    let winner = null;

    try {
      winner = await Promise.any(batchPromises);
      controllers.forEach((controller, ctrlIdx) => {
        if (ctrlIdx !== winner.providerIndex && !controller.signal.aborted) {
          controller.abort();
        }
      });
    } catch (aggregateErr) {
      // All rejected in this batch; proceed to next batch after collecting details
    }

    const settled = await Promise.allSettled(batchPromises);
    settled.forEach((outcome, idx) => {
      const provider = batch[idx];
      if (outcome.status === 'fulfilled') {
        attemptDetails.push({ provider, success: true, error: null });
      } else {
        const errorMsg = outcome.reason?.message || 'Unknown error';
        errors.push({ provider, error: errorMsg });
        attemptDetails.push({ provider, success: false, error: errorMsg });
      }
    });

    if (winner) {
      // Promote temp file to final cache path atomically
      try {
        if (CACHE_ENABLED) {
          const maxBytes = MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024;
          if (cacheSizeBytes + winner.bytesWritten > maxBytes) {
            const targetSize = Math.floor(maxBytes * 0.9);
            evictOldFiles(targetSize);
          }
        }

        if (fs.existsSync(cachePath)) {
          fs.unlinkSync(winner.tempPath);
        } else {
          fs.renameSync(winner.tempPath, cachePath);
          cacheSizeBytes += winner.bytesWritten;
        }
        cacheAccessTimes.set(merkleHex, Date.now());

        winner.cachePath = cachePath;
        winner.attemptDetails = attemptDetails;
        return winner;
      } catch (err) {
        if (fs.existsSync(winner.tempPath)) {
          fs.unlinkSync(winner.tempPath);
        }
        errors.push({ provider: winner.provider, error: err.message });
        const existingIdx = attemptDetails.findIndex(detail => detail.provider === winner.provider);
        if (existingIdx !== -1) {
          attemptDetails[existingIdx] = { provider: winner.provider, success: false, error: err.message };
        } else {
          attemptDetails.push({ provider: winner.provider, success: false, error: err.message });
        }
        // Continue to next batch if available
      }
    }
  }

  const error = new Error('All providers failed');
  error.details = errors;
  throw error;
}

/**
 * 🎯 NEW: Query FindFile() gRPC to find which providers have a specific file
 * Returns array of provider URLs that have this file
 * MOVED BEFORE downloadFile to fix hoisting issue
 */
async function findFileProviders(merkleHex) {
  // Check cache first
  const cached = findFileCache.get(merkleHex);
  if (cached && (Date.now() - cached.timestamp) < FINDFILE_CACHE_TTL) {
    console.log(`   📦 FindFile cache hit (${cached.providers.length} providers)`);
    metrics.findFileHits++;
    return cached.providers;
  }
  
  try {
    console.log(`   🔍 FindFile gRPC query for ${merkleHex.substring(0, 16)}...`);
    metrics.findFileQueries++;
    
    if (!/^[a-f0-9]{64}$/i.test(merkleHex)) {
      throw new Error('Invalid merkleHex');
    }
    
    // ✅ CRITICAL FIX: Convert hex to base64 (Jackal blockchain expects base64!)
    const merkleBase64 = Buffer.from(merkleHex, 'hex').toString('base64');
    console.log(`   🔄 Converted hex to base64: ${merkleBase64.substring(0, 20)}...`);
    
    // Query FindFile with BASE64-encoded merkle (not hex!)
    const command = `
      grpcurl -plaintext -d '{"merkle":"${merkleBase64}"}' ${JACKAL_GRPC_ENDPOINT} canine_chain.storage.Query/FindFile | jq -r '.providerIps[]' 2>/dev/null
    `;
    
    const { stdout } = await execPromise(command, {
      timeout: FINDFILE_TIMEOUT,
      maxBuffer: 1024 * 1024
    });
    
    const providerUrls = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('http://') || line.startsWith('https://'));
    
    if (providerUrls.length === 0) {
      console.log(`   ⚠️  FindFile returned no providers`);
      return [];
    }
    
    console.log(`   ✅ FindFile found ${providerUrls.length} providers with this file`);
    
    // Cache the result
    findFileCache.set(merkleHex, {
      providers: providerUrls,
      timestamp: Date.now()
    });
    if (findFileCache.size > 10000) {
      findFileCache.clear();
    }
    
    saveFindFileCache();
    
    return providerUrls;
    
  } catch (err) {
    console.log(`   ⚠️  FindFile query failed: ${err.message}`);
    return [];
  }
}

/**
 * Download file with request deduplication
 * If same file is requested multiple times, download once and share result
 */
async function downloadFileWithDedup(merkleHex) {
  const cacheKey = merkleHex;

  if (inflightRequests.has(cacheKey)) {
    console.log(`📎 Deduplicating request for ${merkleHex.substring(0, 16)}...`);
    return await inflightRequests.get(cacheKey);
  }

  const downloadPromise = (async () => {
    try {
      return await downloadFile(merkleHex);
    } finally {
      inflightRequests.delete(cacheKey);
    }
  })();

  inflightRequests.set(cacheKey, downloadPromise);

  return await downloadPromise;
}

/**
 * Download file using tiered provider approach
 * 🎯 NEW v3.0.1: Try FindFile() first for targeted queries, fallback to Tier 1 broadcast
 */
async function downloadFile(merkleHex) {
  console.log(`\n📥 Downloading merkle: ${merkleHex.substring(0, 16)}... (full file)`);
  
  const attemptLog = {
    findFile: { tried: 0, errors: [], used: false },
    tier1: { tried: 0, errors: [] }
  };
  
  // 🎯 STEP 1: Try FindFile() if enabled
  if (USE_FINDFILE) {
    try {
      const providersFromFindFile = await findFileProviders(merkleHex);
      
      if (providersFromFindFile.length > 0) {
        console.log(`🎯 FindFile: Trying ${providersFromFindFile.length} targeted providers...`);
        attemptLog.findFile.tried = providersFromFindFile.length;
        attemptLog.findFile.used = true;
        
        try {
          const result = await tryProvidersParallel(providersFromFindFile, merkleHex, TIER1_TIMEOUT);
          console.log(`✅ FindFile success from: ${result.provider}`);
          
          result.attemptLog = attemptLog;
          result.attemptLog.findFile.errors = result.attemptDetails
            .filter(a => !a.success)
            .map(a => `${a.provider}: ${a.error}`);
          
          return result;
        } catch (err) {
          console.log(`⚠️  FindFile providers failed: ${err.message}`);
          if (err.details) {
            attemptLog.findFile.errors = err.details.map(d => `${d.provider}: ${d.error}`);
          }
          metrics.findFileFallbacks++;
          // Continue to Tier 1 fallback
        }
      } else {
        console.log(`⚠️  FindFile returned no providers - falling back to Tier 1`);
        metrics.findFileFallbacks++;
      }
    } catch (err) {
      console.log(`⚠️  FindFile query error: ${err.message}`);
      metrics.findFileFallbacks++;
    }
  }
  
  // 🚀 STEP 2: Fallback to Tier 1 broadcast (original behavior)
  console.log(`🚀 Tier 1 Fallback: Trying ${TIER1_PROVIDERS.length} known providers...`);
  attemptLog.tier1.tried = TIER1_PROVIDERS.length;
  
  try {
    const result = await tryProvidersParallel(TIER1_PROVIDERS, merkleHex, TIER1_TIMEOUT);
    console.log(`✅ Tier 1 success from: ${result.provider}`);
    
    result.attemptLog = attemptLog;
    result.attemptLog.tier1.errors = result.attemptDetails
      .filter(a => !a.success)
      .map(a => `${a.provider}: ${a.error}`);
    
    return result;
  } catch (err) {
    console.log(`❌ All download attempts failed`);
    
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

function isAudioFile(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const audioExtensions = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];
  return audioExtensions.includes(ext);
}

function isPdfFile(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext === 'pdf';
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
      tier1_providers_tried: log.tier1?.tried || 0,
      tier1_errors: log.tier1?.errors?.slice(0, 5) || [],
      findfile_providers_tried: log.findFile?.tried || 0,
      findfile_errors: log.findFile?.errors?.slice(0, 5) || [],
      findfile_used: log.findFile?.used || false,
      total_providers_queried: (log.tier1?.tried || 0) + (log.findFile?.tried || 0),
      grpc_cache_used: grpcProviderCache.valid,
      cache_checked: true
    };
    
    // Add suggestions based on error pattern
    if (log.tier1?.errors?.length > 0 && log.tier1.errors.every(e => e.includes('timeout'))) {
      response.debug.suggestion = 'All providers timed out. Network may be congested. Try again in a moment.';
    } else if (log.tier1?.errors?.length > 0 && log.tier1.errors.some(e => e.includes('404'))) {
      response.debug.suggestion = 'File not found on providers. It may not exist or is still being replicated.';
    } else if (log.findFile?.tried === 0 && log.tier1?.tried > 0) {
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
    version: VERSION,
    service: 'radiant-gateway',
    uptime_seconds: uptime,
    method: 'findfile-targeted-query-tier1-fallback',
    findfile: {
      enabled: USE_FINDFILE,
      cache_entries: findFileCache.size,
      timeout_ms: FINDFILE_TIMEOUT,
      cache_ttl_hours: FINDFILE_CACHE_TTL / 1000 / 60 / 60
    },
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
      cache_access_times_persisted: true,
      findfile_cache_persisted: true
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
  
  const findFileSuccessRate = metrics.findFileQueries > 0
    ? (((metrics.findFileQueries - metrics.findFileFallbacks) / metrics.findFileQueries) * 100).toFixed(2) + '%'
    : 'N/A';
  
  res.json({
    service: 'radiant-gateway',
    version: VERSION,
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
    findfile: {
      enabled: USE_FINDFILE,
      queries: metrics.findFileQueries,
      cache_hits: metrics.findFileHits,
      fallbacks_to_tier1: metrics.findFileFallbacks,
      success_rate: findFileSuccessRate
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
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        deleteRecursive(filePath);
      } else {
        fs.unlinkSync(filePath);
        cacheSizeBytes = Math.max(0, cacheSizeBytes - stats.size);
        cacheAccessTimes.delete(path.basename(filePath));
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
 * ✅ Supports Range requests for video streaming
 * ✅ LRU cache with automatic eviction
 * ✅ Request deduplication
 * ✅ Smart streaming: Videos always stream, large non-videos force download
 * ✅ Cloudflare bypass header for large files (>90MB)
 * ✅ Full persistence: All state survives Docker restarts
 */

// HEAD endpoint for Cloudflare + social preview bots (X, Telegram, Discord)
// - DOES NOT touch Jackal providers
// - Uses local cache if available to derive size
// - Returns fast, header-only response for bots and the Cloudflare Worker
app.head('/file/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const { name } = req.query;

    const isMerkleHex = /^[a-f0-9]{64}$/i.test(identifier);

    // Invalid identifier
    if (!isMerkleHex) {
      return res.status(400).json({
        error: 'Invalid identifier',
        message: 'Only 64-char merkleHex identifiers are supported'
      });
    }

    const merkleHex = identifier;

    const fileName = name || `file-${merkleHex.substring(0, 16)}`;
    const contentType = getContentType(fileName);
    const safeFileName = sanitizeFilename(fileName);

    const isVideo = isVideoFile(fileName);
    const isAudio = isAudioFile(fileName);
    const isPDF = isPdfFile(fileName);

    let sizeBytes = 0;
    let sizeMB = 0;
    let inCache = false;

    // Only inspect local disk cache – never hit providers on HEAD
    if (isInCache(merkleHex)) {
      try {
        const cachePath = getCachePath(merkleHex);
        const stat = fs.statSync(cachePath);
        cacheAccessTimes.set(merkleHex, Date.now());
        sizeBytes = stat.size;
        sizeMB = sizeBytes / (1024 * 1024);
        inCache = true;
      } catch (e) {
        sizeBytes = 0;
        sizeMB = 0;
        inCache = false;
      }
    }

    const isLarge = sizeMB > LARGE_FILE_THRESHOLD_MB;

    // Mirror streaming / disposition logic from GET, but only using cached size info
    let contentDisposition = 'inline';
    let streamingMode = 'inline-small';
    let bypassCloudflare = false;
    let bypassReason = 'size-unknown';

    if (isVideo) {
      streamingMode = 'video-stream';
      contentDisposition = 'inline';
      if (isLarge) {
        bypassCloudflare = true;
        bypassReason = 'large-video';
      } else {
        bypassCloudflare = false;
        bypassReason = inCache ? 'small-video-cached' : 'small-video-unknown-size';
      }
    } else if (isAudio) {
      streamingMode = 'audio-stream';
      contentDisposition = 'inline';
      if (isLarge) {
        bypassCloudflare = true;
        bypassReason = 'large-audio';
      } else {
        bypassCloudflare = false;
        bypassReason = inCache ? 'small-audio-cached' : 'small-audio-unknown-size';
      }
    } else if (isPDF) {
      streamingMode = 'pdf-stream';
      contentDisposition = 'inline';
      if (isLarge) {
        bypassCloudflare = true;
        bypassReason = 'large-pdf';
      } else {
        bypassCloudflare = false;
        bypassReason = inCache ? 'small-pdf-cached' : 'small-pdf-unknown-size';
      }
    } else {
      if (isLarge && sizeMB > 0) {
        // Non-video large file: same idea as GET → force download + bypass
        streamingMode = 'force-download';
        contentDisposition = 'attachment';
        bypassCloudflare = true;
        bypassReason = 'large-file';
      } else {
        streamingMode = 'inline-small';
        contentDisposition = 'inline';
        bypassCloudflare = false;
        bypassReason = inCache ? 'small-file-cached' : 'size-unknown';
      }
    }

    // Standard headers (no body)
    res.setHeader('Content-Type', contentType);
    if (sizeBytes > 0) {
      res.setHeader('Content-Length', String(sizeBytes));
    }
    res.setHeader(
      'Content-Disposition',
      `${contentDisposition}; filename="${safeFileName}"`
    );
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');

    // Extra metadata for debugging / clients / bots
    res.setHeader('X-Identifier-Type', 'merkleHex');
    res.setHeader('X-File-Size-MB', sizeMB.toFixed(2));
    res.setHeader('X-Streaming-Mode', streamingMode);
    res.setHeader('X-Provider-Source', inCache ? 'cache' : 'unknown');

    // Critical for Cloudflare Worker logic
    res.setHeader('X-Cloudflare-Bypass', bypassCloudflare ? 'true' : 'false');
    res.setHeader('X-Bypass-Reason', bypassReason);

    // Important: HEAD must end with no body
    return res.status(200).end();
  } catch (err) {
    // Fail SAFE: tell Cloudflare not to cache if HEAD logic errors
    try {
      res.setHeader('X-Cloudflare-Bypass', 'true');
      res.setHeader('X-Bypass-Reason', 'head-error');
    } catch (e) {
      // ignore header failures
    }
    res.status(500);
    return res.end();
  }
});

app.get('/file/:identifier', async (req, res) => {
  if (res.headersSent) return;
  const startTime = Date.now();
  metrics.totalRequests++;
  
  const { identifier } = req.params; // Must be 64-char merkleHex
  const { name } = req.query;
  const rangeHeader = req.headers.range;
  
  const isMerkleHex = /^[a-f0-9]{64}$/i.test(identifier);
  
  if (!isMerkleHex) {
    if (res.headersSent) return;
    return res.status(400).json({ 
      error: 'Invalid identifier',
      message: 'Only 64-char merkleHex identifiers are supported'
    });
  }
  
  const merkleHex = identifier;
  
  console.log(`\n📥 Request for file: ${merkleHex.substring(0, 16)}... (merkleHex)`);
  if (name) console.log(`📄 Filename: ${name}`);
  if (rangeHeader) console.log(`📏 Range: ${rangeHeader}`);
  
  try {
    let source = 'network';
    
    const fileName = name || `file-${merkleHex.substring(0, 16)}`;
    const contentType = getContentType(fileName);
    const safeFileName = sanitizeFilename(fileName);
    let contentDisposition = 'inline';

    // ============================================================
    // CACHE-FIRST SHORT-CIRCUIT LOGIC
    // ============================================================

    if (isInCache(merkleHex)) {
        metrics.cacheHits++;
        console.log(`⚡ Cache hit – skipping provider calls completely`);

        const cachePath = getCachePath(merkleHex);
        cacheAccessTimes.set(merkleHex, Date.now());
        const fileStat = fs.statSync(cachePath);
        const fileSize = fileStat.size;
        const fileSizeMB = fileSize / (1024 * 1024);
        const isLargeFile = fileSizeMB > LARGE_FILE_THRESHOLD_MB;

        const isVideo = isVideoFile(fileName);
        const isAudio = isAudioFile(fileName);
        const isPDF = isPdfFile(fileName);
        const isStreamable = isVideo || isAudio || isPDF;

        let bypassCloudflare = false;
        let streamingMode = 'inline';

        if (isVideo) {
          contentDisposition = 'inline';
          streamingMode = 'video-stream';
          bypassCloudflare = isLargeFile;
          if (isLargeFile) metrics.videoStreams++;
        } else if (isAudio) {
          contentDisposition = 'inline';
          streamingMode = 'audio-stream';
          bypassCloudflare = isLargeFile;
        } else if (isPDF) {
          contentDisposition = 'inline';
          streamingMode = 'pdf-stream';
          bypassCloudflare = isLargeFile;
        } else if (isLargeFile) {
          contentDisposition = 'attachment';
          streamingMode = 'force-download';
          bypassCloudflare = true;
          metrics.largeFileDownloads++;
        } else {
          contentDisposition = 'inline';
          streamingMode = 'inline-small';
          bypassCloudflare = false;
        }

        // Handle Range requests from cache
        if (rangeHeader) {
            console.log(`🎯 Range request satisfied from LOCAL CACHE`);

            const range = parseRangeHeader(rangeHeader, fileSize);
            if (!range || !isStreamable) {
                if (res.headersSent) return;
                return res.status(416).send('Requested Range Not Satisfiable');
            }

            const { start, end } = range;
            const chunkSize = (end - start) + 1;

            if (res.headersSent) return;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', chunkSize);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `${contentDisposition}; filename="${safeFileName}"`);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('X-Provider-Source', 'cache');
            res.setHeader('X-Streaming-Mode', 'range-from-cache');
            res.setHeader('X-Identifier-Type', 'merkleHex');
            res.setHeader('X-File-Size-MB', fileSizeMB.toFixed(2));
            res.setHeader('X-FindFile-Used', 'false');

            if (bypassCloudflare) {
              res.setHeader('X-Cloudflare-Bypass', 'true');
              res.setHeader('X-Bypass-Reason', isVideo ? 'large-video' : 'large-file');
            } else {
              res.setHeader('X-Cloudflare-Bypass', 'false');
            }

            activeStreams.add(merkleHex);
            const stream = fs.createReadStream(cachePath, { start, end });
            stream.on('close', () => activeStreams.delete(merkleHex));
            stream.on('error', () => activeStreams.delete(merkleHex));
            if (res.headersSent) return;
            return stream.pipe(res);
        }

        // Handle full GET from cache
        console.log(`📦 Full GET satisfied from LOCAL CACHE`);
        if (res.headersSent) return;
        res.status(200);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Disposition', `${contentDisposition}; filename="${safeFileName}"`);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-Provider-Source', 'cache');
        res.setHeader('X-Streaming-Mode', 'full-from-cache');
        res.setHeader('X-Identifier-Type', 'merkleHex');
        res.setHeader('X-File-Size-MB', fileSizeMB.toFixed(2));
        res.setHeader('X-FindFile-Used', 'false');

        if (bypassCloudflare) {
          res.setHeader('X-Cloudflare-Bypass', 'true');
          res.setHeader('X-Bypass-Reason', isVideo ? 'large-video' : 'large-file');
        } else {
          res.setHeader('X-Cloudflare-Bypass', 'false');
        }

        activeStreams.add(merkleHex);
        const stream = fs.createReadStream(cachePath);
        stream.on('close', () => activeStreams.delete(merkleHex));
        stream.on('error', () => activeStreams.delete(merkleHex));
        if (res.headersSent) return;
        return stream.pipe(res);
    }

    if (rangeHeader) {
      console.log(`🌐 Range request - downloading full file before streaming from disk...`);
    } else {
      console.log(`🌐 Cache miss - downloading from network...`);
    }
    
    metrics.cacheMisses++;
    
    // Use request deduplication to download once, then serve from disk
    const result = await downloadFileWithDedup(merkleHex);
    const cachePath = result.cachePath || getCachePath(merkleHex);
    cacheAccessTimes.set(merkleHex, Date.now());
    const fileStat = fs.statSync(cachePath);
    const fileSize = fileStat.size;
    const fileSizeMB = fileSize / (1024 * 1024);
    const usedFindFile = result.attemptLog?.findFile?.used || false;
    source = result.provider ? `provider:${result.provider}` : 'provider';

    const isVideo = isVideoFile(fileName);
    const isAudio = isAudioFile(fileName);
    const isPDF = isPdfFile(fileName);
    const isStreamable = isVideo || isAudio || isPDF;

    const isLargeFile = fileSizeMB > LARGE_FILE_THRESHOLD_MB;

    contentDisposition = 'inline';
    let bypassCloudflare = false;
    let streamingMode = 'inline';

    if (isVideo) {
      contentDisposition = 'inline';
      streamingMode = 'video-stream';
      bypassCloudflare = isLargeFile;
      if (isLargeFile) metrics.videoStreams++;
    } else if (isAudio) {
      contentDisposition = 'inline';
      streamingMode = 'audio-stream';
      bypassCloudflare = isLargeFile;
    } else if (isPDF) {
      contentDisposition = 'inline';
      streamingMode = 'pdf-stream';
      bypassCloudflare = isLargeFile;
    } else if (isLargeFile) {
      contentDisposition = 'attachment';
      streamingMode = 'force-download';
      bypassCloudflare = true;
      metrics.largeFileDownloads++;
    } else {
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
    
    // ============================================================
    // RANGE REQUEST HANDLING (SAFE MODE - SERVE FROM CACHE WHEN AVAILABLE)
    // ============================================================

    // Serve Range requests exclusively from disk
    if (rangeHeader) {
        const range = parseRangeHeader(rangeHeader, fileSize);
        if (!range || !isStreamable) {
            if (res.headersSent) return;
            return res.status(416).send('Requested Range Not Satisfiable');
        }

        const { start, end } = range;
        const chunkSize = (end - start) + 1;

        if (res.headersSent) return;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', chunkSize);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `${contentDisposition}; filename="${safeFileName}"`);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Provider-Source', source);
        res.setHeader('X-Streaming-Mode', 'range-from-cache');
        res.setHeader('X-Identifier-Type', 'merkleHex');
        res.setHeader('X-File-Size-MB', fileSizeMB.toFixed(2));
        res.setHeader('X-FindFile-Used', usedFindFile ? 'true' : 'false');

        if (bypassCloudflare) {
          res.setHeader('X-Cloudflare-Bypass', 'true');
          res.setHeader('X-Bypass-Reason', isVideo ? 'large-video' : 'large-file');
        } else {
          res.setHeader('X-Cloudflare-Bypass', 'false');
        }

        activeStreams.add(merkleHex);
        const stream = fs.createReadStream(cachePath, { start, end });
        stream.on('close', () => activeStreams.delete(merkleHex));
        stream.on('error', () => activeStreams.delete(merkleHex));
        if (res.headersSent) return;
        return stream.pipe(res);
    }
    
    if (res.headersSent) return;
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `${contentDisposition}; filename="${safeFileName}"`);
    res.setHeader('X-Provider-Source', source);
    res.setHeader('X-Identifier-Type', 'merkleHex');
    res.setHeader('X-File-Size-MB', fileSizeMB.toFixed(2));
    res.setHeader('X-Streaming-Mode', streamingMode);
    res.setHeader('X-FindFile-Used', usedFindFile ? 'true' : 'false'); // 🎯 NEW

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
    console.log(`   Status: 200`);
    console.log(`   Disposition: ${contentDisposition}`);
    console.log(`   Cloudflare Bypass: ${bypassCloudflare}\n`);
    
    if (res.headersSent) return;
    activeStreams.add(merkleHex);
    const stream = fs.createReadStream(cachePath);
    stream.on('close', () => activeStreams.delete(merkleHex));
    stream.on('error', () => activeStreams.delete(merkleHex));
    return stream.pipe(res);
    
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
    
    if (res.headersSent) return;
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
  console.log(`🚀 Radiant Gateway v${VERSION} - Smart Racing Edition`);
  console.log(`${'='.repeat(80)}`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 File endpoint: http://localhost:${PORT}/file/{merkleHex}?name={filename}`);
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
  console.log(`   ✅ Accepts merkleHex identifiers`);
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
