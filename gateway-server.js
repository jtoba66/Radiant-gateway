// gateway-server.js (IPFS Gateway Proxy)
// Routes Jackal CIDs through public IPFS gateways
const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

// Jackal REST endpoint for provider discovery
const JACKAL_REST_ENDPOINT = 'https://rest.lavenderfive.com:443/jackal';

// Public IPFS gateways to try (in order)
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs',
  'https://dweb.link/ipfs',
  'https://cloudflare-ipfs.com/ipfs',
  'https://gateway.pinata.cloud/ipfs',
  'https://ipfs.filebase.io/ipfs'
];

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range'],
  exposedHeaders: ['Content-Length', 'Content-Type', 'Accept-Ranges']
}));

// Helper: Get active storage providers from Jackal network
async function getStorageProviders() {
  try {
    const url = `${JACKAL_REST_ENDPOINT}/storage/providers`;
    console.log(`📡 Fetching providers from: ${url}`);
    
    const response = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse provider response'));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }).on('error', reject).setTimeout(10000, function() {
        this.destroy();
        reject(new Error('Request timeout'));
      });
    });
    
    if (response && response.providers && Array.isArray(response.providers)) {
      const providers = response.providers
        .map(p => p.ip || p.address)
        .filter(Boolean);
      
      console.log(`✅ Found ${providers.length} active providers from blockchain`);
      return providers;
    }
    
    console.log('⚠️  No providers in response');
    return [];
  } catch (err) {
    console.error('⚠️  Provider discovery failed:', err.message);
    return [];
  }
}

// Helper: Download from URL
function downloadFromUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFromUrl(res.headers.location).then(resolve).catch(reject);
      }
      
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).setTimeout(30000, function() {
      this.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Helper: Try downloading from IPFS gateways
async function downloadFromIPFS(cid) {
  let lastError = null;
  
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const url = `${gateway}/${cid}`;
      console.log(`⬇️  Trying: ${url}`);
      
      const data = await downloadFromUrl(url);
      
      // Verify it's not an error page
      if (data.length < 1000 && data.toString('utf8').toLowerCase().includes('<!doctype html>')) {
        console.log(`⚠️  Got HTML error page, trying next gateway...`);
        continue;
      }
      
      console.log(`✅ Downloaded ${data.length} bytes from ${gateway}`);
      return data;
    } catch (err) {
      console.log(`❌ Failed ${gateway}: ${err.message}`);
      lastError = err;
      continue;
    }
  }
  
  throw new Error(`All IPFS gateways failed. Last error: ${lastError?.message}`);
}

// Health check
app.get('/health', async (req, res) => {
  // Try to get providers for health check
  const providers = await getStorageProviders();
  
  res.json({ 
    status: 'ok', 
    service: 'radiant-gateway',
    method: 'ipfs-proxy',
    rest_endpoint: JACKAL_REST_ENDPOINT,
    ipfs_gateways: IPFS_GATEWAYS.length,
    active_providers: providers.length
  });
});

// Main file endpoint
// Accepts both merkle hash and IPFS CID
app.get('/file/:identifier', async (req, res) => {
  const { identifier } = req.params;
  const { name } = req.query;
  
  console.log(`\n📥 Request for file: ${identifier}`);
  if (name) console.log(`📄 Filename: ${name}`);
  
  try {
    // Download from IPFS gateways
    const fileData = await downloadFromIPFS(identifier);
    
    // Determine filename and content type
    const fileName = name || `file-${identifier.substring(0, 8)}`;
    const contentType = getContentType(fileName);
    
    // Send response
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fileData.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    
    console.log(`✅ Serving: ${fileName} (${fileData.length} bytes)`);
    console.log(`   Content-Type: ${contentType}\n`);
    
    res.send(fileData);
    
  } catch (err) {
    console.error('❌ Error:', err.message, '\n');
    
    if (err.message?.includes('timeout')) {
      return res.status(504).json({ 
        error: 'Gateway timeout',
        message: 'IPFS gateways took too long to respond',
        identifier 
      });
    }
    
    res.status(500).json({ 
      error: 'Download failed',
      message: err.message || 'Could not retrieve file from IPFS',
      identifier,
      hint: 'Make sure the CID is valid and the file exists on IPFS'
    });
  }
});

// Helper: Determine MIME type
function getContentType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
    'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
    'pdf': 'application/pdf', 'txt': 'text/plain', 'json': 'application/json',
    'mp4': 'video/mp4', 'mp3': 'audio/mpeg', 'wav': 'audio/wav',
    'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Radiant Gateway running on port ${PORT}`);
  console.log(`📡 File endpoint: http://localhost:${PORT}/file/{cid}?name={filename}`);
  console.log(`🌐 Using ${IPFS_GATEWAYS.length} IPFS gateways`);
  console.log(`🔗 Jackal REST: ${JACKAL_REST_ENDPOINT}`);
  console.log(`\n✅ Ready to serve files!\n`);
});