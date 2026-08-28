cat > app.js << 'EOF'
// ============================================================
// Shopee Resolver API
// Endpoint: POST /resolve { url: "https://s.shopee.co.id/xxx" }
// Response: { originalUrl, canonicalUrl, itemId, shopId }
// ============================================================

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOPEE_COUNTRY = process.env.SHOPEE_COUNTRY || 'id';

// Cache browser instance (reuse untuk performance)
let browser;

async function initBrowser() {
  if (browser) return browser;
  
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ]
  });
  
  console.log('[Browser] Initialized');
  return browser;
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'shopee-resolver',
    country: SHOPEE_COUNTRY,
    uptime: process.uptime()
  });
});

// Main endpoint
app.post('/resolve', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing url in body' 
    });
  }
  
  const page = await browser.newPage().catch(() => null);
  if (!page) {
    return res.status(500).json({ 
      success: false, 
      error: 'Browser not available' 
    });
  }
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'id-ID,id;q=0.9' });
    
    console.log(`[Resolve] Start: ${url}`);
    const startTime = Date.now();
    
    // Goto URL, tunggu network idle untuk pastikan JS redirect selesai
    await page.goto(url, { 
      waitUntil: 'networkidle0', 
      timeout: 30000 
    });
    
    // Extra wait untuk handle Shopee double-redirect
    await new Promise(r => setTimeout(r, 1500));
    
    const finalUrl = page.url();
    const elapsed = Date.now() - startTime;
    console.log(`[Resolve] Done in ${elapsed}ms: ${finalUrl}`);
    
    // Extract itemId dari URL canonical
    let itemId = '';
    let shopId = '';
    const match = finalUrl.match(/i\.(\d+)\.(\d+)/);
    if (match) {
      shopId = match[1];
      itemId = match[2];
    }
    
    await page.close();
    
    res.json({
      success: true,
      originalUrl: url,
      canonicalUrl: finalUrl,
      itemId: itemId,
      shopId: shopId,
      elapsed: elapsed,
      isSameUrl: finalUrl === url,
      timestamp: new Date().toISOString()
    });
    
  } catch (e) {
    console.error(`[Resolve] Error: ${e.message}`);
    if (page) await page.close().catch(() => {});
    res.status(500).json({
      success: false,
      originalUrl: url,
      error: String(e.message || e).slice(0, 200)
    });
  }
});

// Batch endpoint (resolve banyak URL sekaligus)
app.post('/resolve-batch', async (req, res) => {
  const { urls } = req.body;
  
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'urls must be a non-empty array' 
    });
  }
  
  const results = [];
  
  for (const url of urls) {
    const page = await browser.newPage().catch(() => null);
    if (!page) {
      results.push({ originalUrl: url, success: false, error: 'No browser' });
      continue;
    }
    
    try {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      await new Promise(r => setTimeout(r, 1500));
      
      const finalUrl = page.url();
      const match = finalUrl.match(/i\.(\d+)\.(\d+)/);
      
      results.push({
        originalUrl: url,
        canonicalUrl: finalUrl,
        itemId: match ? match[2] : '',
        shopId: match ? match[1] : '',
        success: true,
        isSameUrl: finalUrl === url
      });
    } catch (e) {
      results.push({ originalUrl: url, success: false, error: String(e.message || e).slice(0, 100) });
    } finally {
      await page.close().catch(() => {});
    }
  }
  
  res.json({ 
    success: true, 
    count: results.length, 
    results: results 
  });
});

// Keep browser warm (auto-restart jika idle)
setInterval(async () => {
  try {
    if (!browser || !browser.connected) {
      console.log('[Browser] Reinitializing...');
      await initBrowser();
    }
  } catch (e) {
    console.error('[Browser] Health check failed:', e.message);
  }
}, 60000);

// Startup
(async () => {
  try {
    await initBrowser();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Shopee Resolver] Running on port ${PORT}`);
      console.log(`[Shopee Resolver] Country: ${SHOPEE_COUNTRY}`);
    });
  } catch (e) {
    console.error('[Startup] Failed:', e.message);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Shutdown] Closing browser...');
  if (browser) await browser.close();
  process.exit(0);
});
EOF
echo "app.js created"
