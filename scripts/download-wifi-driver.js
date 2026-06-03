#!/usr/bin/env node
/**
 * Downloads the Legion GO Wi-Fi driver and bundles it into resources/
 * so it can be extracted from the app on a fresh Windows install with no internet.
 *
 * Run automatically before every build via the "prebuild" npm script.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const WIFI_URL  = 'https://download.lenovo.com/consumer/mobiles/pfx8040frevuuff0.exe';
const OUT_DIR   = path.join(__dirname, '..', 'resources');
const OUT_FILE  = path.join(OUT_DIR, 'wifi-driver.exe');

function download(url, dest, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', chunk => {
        received += chunk.length;
        file.write(chunk);
        if (total > 0) {
          process.stdout.write(`\r  Downloading Wi-Fi driver… ${Math.round(received / total * 100)}%`);
        }
      });
      res.on('end', () => { file.end(); process.stdout.write('\n'); resolve(); });
      res.on('error', reject);
      file.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  if (fs.existsSync(OUT_FILE)) {
    const size = fs.statSync(OUT_FILE).size;
    if (size > 1_000_000) {          // > 1 MB — looks like a real file
      console.log(`  Wi-Fi driver already bundled (${(size / 1024 / 1024).toFixed(1)} MB) — skipping download`);
      return;
    }
    fs.unlinkSync(OUT_FILE);         // truncated/corrupt — re-download
  }

  console.log(`  Downloading Wi-Fi driver from Lenovo…`);
  console.log(`  ${WIFI_URL}`);
  await download(WIFI_URL, OUT_FILE);

  const size = fs.statSync(OUT_FILE).size;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(OUT_FILE));
  console.log(`  Bundled — ${(size / 1024 / 1024).toFixed(1)} MB  SHA256: ${hash.digest('hex').slice(0, 16)}…`);
})().catch(err => {
  console.error(`\n  ERROR: Could not download Wi-Fi driver: ${err.message}`);
  console.error('  Build will continue but the Wi-Fi extraction feature will not work.');
  // Don't exit(1) — let the build proceed without the driver
});
