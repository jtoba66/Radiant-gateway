// Cloudflare Worker for Radiant Gateway - Smart Caching
// Version: 1.0.1
//
// This worker sits between users and your gateway server.
// It caches small files (<90MB) at Cloudflare edge for fast global delivery.
// Large files (>90MB) bypass Cloudflare cache and go directly to your server.
//
// Deploy this to: gateway.lazybird.io/*

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
  })
  
  async function handleRequest(request) {
    const url = new URL(request.url);
  
    // ---------------------------------------------
    // NEW: Health Check Handler
    // ---------------------------------------------
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }
  
    // ---------------------------------------------
    // Only process /file/ requests
    // ---------------------------------------------
    if (!url.pathname.startsWith('/file/')) {
      // Pass through all other requests untouched
      return fetch(request);
    }
  
    console.log(`Worker: Processing ${url.pathname}`);
  
    // ---------------------------------------------
    // Step 1: Make a HEAD request to check file size
    // ---------------------------------------------
    try {
      const headRequest = new Request(url.toString(), {
        method: 'HEAD',
        headers: request.headers
      });
  
      const headResponse = await fetch(headRequest, {
        cf: {
          cacheTtl: 60,            // Don't cache HEAD aggressively
          cacheEverything: false
        }
      });
  
      // Read headers sent by your backend
      const fileSizeMB = parseFloat(headResponse.headers.get('X-File-Size-MB') || '0');
      const cloudflareBypass = headResponse.headers.get('X-Cloudflare-Bypass') === 'true';
      const bypassReason = headResponse.headers.get('X-Bypass-Reason') || 'unknown';
  
      console.log(`Worker: File size = ${fileSizeMB}MB, Bypass = ${cloudflareBypass}, Reason = ${bypassReason}`);
  
      // ---------------------------------------------
      // Step 2: Decide if we should cache or bypass
      // ---------------------------------------------
      if (cloudflareBypass || fileSizeMB > 90) {
        // Large file or backend says not to cache
        console.log(`Worker: Bypassing cache for large file (${fileSizeMB}MB)`);
  
        return fetch(request, {
          cf: {
            cacheEverything: false,
            cacheTtl: 0,
            polish: 'off',
            minify: { javascript: false, css: false, html: false }
          }
        });
      }
  
      // ---------------------------------------------
      // Small file: aggressive caching (1 year)
      // ---------------------------------------------
      console.log(`Worker: Caching small file (${fileSizeMB}MB)`);
  
      return fetch(request, {
        cf: {
          cacheEverything: true,
          cacheTtl: 31536000,     // 1 year
          respectStrongEtags: true
        }
      });
  
    } catch (error) {
      console.error(`Worker Error: ${error.message}`);
  
      // Fail-safe: Never cache if HEAD fails (prevents huge mistakes)
      return fetch(request, {
        cf: {
          cacheEverything: false,
          cacheTtl: 0
        }
      });
    }
  }
  