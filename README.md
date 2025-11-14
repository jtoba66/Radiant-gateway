# Radiant Gateway - Deployment Guide

Production-ready gateway for serving files from Jackal decentralized storage network with Cloudflare CDN integration.

## 🌟 Features

- ✅ **Smart Streaming**: Videos always stream, large files (>90MB) auto-download
- ✅ **Cloudflare Integration**: Hybrid caching - small files cached at edge, large files bypass
- ✅ **LRU Cache**: 50GB local cache with automatic eviction
- ✅ **Provider Health Tracking**: Monitors and persists provider reliability
- ✅ **Range Requests**: Video streaming support
- ✅ **Request Deduplication**: Prevents duplicate downloads
- ✅ **24-Hour gRPC Caching**: Reduces latency for provider queries
- ✅ **Detailed Metrics**: Comprehensive tracking and analytics

---

## 📋 Prerequisites

- **Server**: VPS with Ubuntu 20.04+ (minimum 2GB RAM)
- **Domain**: Configured on Cloudflare
- **Docker**: Installed on server
- **Cloudflare Account**: Free plan is sufficient

---

## 🚀 Quick Start (Production)

### 1. Clone Repository

```bash
git clone https://github.com/jtoba66/Radiant-gateway.git
cd Radiant-gateway
```

### 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

Edit values as needed (defaults work fine for most cases).

### 3. Deploy with Docker

```bash
# Start the gateway
docker-compose up -d

# Check logs
docker-compose logs -f

# Check status
docker-compose ps
```

### 4. Verify Deployment

```bash
# Health check
curl http://localhost:3001/health

# Should return JSON with status: "ok"
```

---

## 🌐 Cloudflare Setup

### Prerequisites
- Domain added to Cloudflare
- Nameservers updated to Cloudflare's
- A record pointing to your server IP

### 1. Configure SSL Mode

1. Go to Cloudflare Dashboard → **SSL/TLS**
2. Set to **"Flexible"** mode

### 2. Deploy Worker

1. Go to **Workers & Pages** → **Create Application**
2. Create new Worker named `radiant-gateway-cache`
3. Copy code from `cloudflare-worker.js`
4. Deploy

### 3. Add Worker Route

1. Go to your worker → **Triggers**
2. Add route: `gateway.yourdomain.com/file/*`
3. Select your zone

### 4. Configure DNS

Ensure your gateway subdomain has:
- **Type**: A Record
- **Name**: gateway
- **Content**: Your server IP
- **Proxy**: Enabled (orange cloud) ✅

---

## 📊 Monitoring

### Health Check
```bash
curl https://gateway.yourdomain.com/health
```

### Metrics
```bash
curl https://gateway.yourdomain.com/metrics
```

Returns:
- Request statistics
- Cache hit rates
- Provider health
- Video streams / large downloads
- Error tracking

### Provider Health
```bash
curl https://gateway.yourdomain.com/providers/health
```

### Cache Statistics
```bash
curl https://gateway.yourdomain.com/cache/stats
```

### Cloudflare Analytics

View in Cloudflare Dashboard:
- **Analytics** → Traffic and bandwidth
- **Caching** → Cache hit rates
- **Workers** → Request counts and logs

---

## 🧪 Testing

### Test Small File (Should Cache)
```bash
# First request
curl -I https://gateway.yourdomain.com/file/{merkleHex}?name=small.jpg

# Look for:
# cf-cache-status: MISS (first time)
# x-file-size-mb: 2.5
# x-cloudflare-bypass: false

# Second request
curl -I https://gateway.yourdomain.com/file/{merkleHex}?name=small.jpg

# Look for:
# cf-cache-status: HIT (cached!)
```

### Test Large File (Should Bypass)
```bash
curl -I https://gateway.yourdomain.com/file/{merkleHex}?name=large-video.mp4

# Look for:
# cf-cache-status: DYNAMIC or BYPASS
# x-file-size-mb: 150.2
# x-cloudflare-bypass: true
# x-bypass-reason: large-video
```

### Test Video Streaming
```bash
# Request video with Range header
curl -I -H "Range: bytes=0-1000" https://gateway.yourdomain.com/file/{merkleHex}?name=video.mp4

# Look for:
# status: 206 Partial Content
# content-range: bytes 0-1000/...
# x-streaming-mode: video-stream
```

---

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `CACHE_ENABLED` | `true` | Enable local caching |
| `MAX_CACHE_SIZE_GB` | `50` | Maximum cache size |
| `JACKAL_GRPC_ENDPOINT` | `jackal-grpc.polkachu.com:17590` | gRPC endpoint |

### File Size Threshold

Edit in `radiant-gateway-grpc.js`:
```javascript
const LARGE_FILE_THRESHOLD_MB = 90; // Change if needed
```

### Video Extensions

Add/remove extensions in `radiant-gateway-grpc.js`:
```javascript
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'ogg'];
```

---

## 📦 Docker Management

### Start Gateway
```bash
docker-compose up -d
```

### Stop Gateway
```bash
docker-compose down
```

### View Logs
```bash
docker-compose logs -f
```

### Restart Gateway
```bash
docker-compose restart
```

### Update Gateway
```bash
git pull
docker-compose down
docker-compose up -d --build
```

---

## 🛠️ Troubleshooting

### Gateway Not Responding

```bash
# Check if container is running
docker ps

# Check logs
docker-compose logs

# Restart
docker-compose restart
```

### Cloudflare Not Caching

1. Check DNS: Orange cloud enabled?
2. Check SSL mode: Should be "Flexible"
3. Check Worker route: Correct pattern?
4. Check Worker logs in Cloudflare Dashboard

### Provider Connection Issues

```bash
# Check gRPC tools are installed (in container)
docker exec -it radiant-gateway bash
which grpcurl
which jq

# Refresh provider cache
curl -X POST https://gateway.yourdomain.com/providers/refresh
```

### Cache Issues

```bash
# Check cache size
curl https://gateway.yourdomain.com/cache/stats

# Clear cache if needed (admin only!)
curl -X DELETE https://gateway.yourdomain.com/cache/clear
```

---

## 🔐 Security Notes

### Cloudflare SSL Mode: "Flexible"
- User → Cloudflare: **HTTPS (encrypted)** ✅
- Cloudflare → Server: **HTTP (unencrypted)** ⚠️

This is acceptable because:
- Your server is on a VPS (private network)
- Cloudflare provides DDoS protection
- Users always get HTTPS

**For enhanced security**, you can:
1. Set up Nginx with Let's Encrypt on server
2. Change Cloudflare SSL mode to "Full (strict)"

### Admin Endpoints

**Protect these in production:**
- `DELETE /cache/clear` - Cache clearing
- `POST /providers/refresh` - Force provider refresh

Add authentication or IP filtering for admin routes.

---

## 📈 Performance Tips

### 1. Adjust Cache Size
```bash
# For high-traffic sites, increase cache
MAX_CACHE_SIZE_GB=100
```

### 2. Monitor Cache Hit Rate
- Target: 50-80% for small files
- View: `/metrics` endpoint or Cloudflare Analytics

### 3. Provider Health
- Check `/providers/health` regularly
- Poor performers are auto-deprioritized

### 4. Cloudflare Worker
- Free plan: 100,000 requests/day
- Upgrade if needed for high traffic

---

## 🏗️ Architecture

```
┌──────────────┐
│    Users     │ (HTTPS)
└──────┬───────┘
       │
       ▼
┌─────────────────────────┐
│   Cloudflare Edge       │
│   - SSL termination     │
│   - Smart caching       │
│   - DDoS protection     │
└──────┬──────────────────┘
       │ (HTTP)
       ▼
┌─────────────────────────┐
│   Your Server           │
│   - Docker container    │
│   - Gateway (Node.js)   │
│   - Local cache (50GB)  │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────┐
│   Jackal Network        │
│   - 16 Tier-1 providers │
│   - gRPC fallback       │
│   - Decentralized store │
└─────────────────────────┘
```

---

## 📄 API Endpoints

### Public Endpoints

**GET /file/:identifier**
- Download/stream files
- Supports both CID and merkleHex
- Query params: `?name=filename.ext`
- Headers: `Range` for video streaming

**GET /health**
- Health check and status

**GET /metrics**
- Detailed metrics and analytics

**GET /cache/stats**
- Cache usage statistics

**GET /providers/health**
- Provider reliability stats

### Admin Endpoints

**POST /providers/refresh**
- Force refresh provider list

**DELETE /cache/clear**
- Clear all cached files

---

## 🆘 Support

- **Issues**: https://github.com/jtoba66/Radiant-gateway/issues
- **Jackal Docs**: https://docs.jackalprotocol.com
- **Cloudflare Docs**: https://developers.cloudflare.com

---

## 📜 License

MIT License - see LICENSE file for details

---

## 🙏 Credits

Built with:
- [Jackal Protocol](https://jackalprotocol.com) - Decentralized storage
- [Cloudflare Workers](https://workers.cloudflare.com) - Edge computing
- [Express.js](https://expressjs.com) - Web framework
- [Docker](https://docker.com) - Containerization