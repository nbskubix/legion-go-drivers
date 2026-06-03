const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const axios = require('axios');

// Legion GO 8APU1 product GUID from Lenovo support
const LENOVO_PRODUCT_ID = '59854FE5-22AB-4152-BB16-167F8610F97F';
const LENOVO_OS_ID = '9'; // Windows 11 64-bit
const LENOVO_API_URL = `https://pcsupport.lenovo.com/us/en/api/v4/downloads/drivers?productId=${LENOVO_PRODUCT_ID}&osId=${LENOVO_OS_ID}&categoryId=`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://pcsupport.lenovo.com/us/en/products/laptops-and-netbooks/legion-series/legion-go-8apu1/downloads/driver-list/',
};

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'Legion GO Driver Manager',
    backgroundColor: '#1a1a2e',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// Surface any unhandled crash as a dialog rather than silent exit
process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Legion GO Drivers — startup error', err.stack || err.message);
  app.quit();
});

// Fetch drivers from Lenovo's API
ipcMain.handle('fetch-drivers', async () => {
  const response = await axios.get(LENOVO_API_URL, { headers: HEADERS, timeout: 30000 });
  const body = response.data?.body;
  if (!body) throw new Error('Unexpected response from Lenovo API');

  const items = (body.DownloadItems || []).map(item => {
    // Pick the primary executable file (skip HTML readmes)
    const files = item.Files.filter(f => f.TypeString !== 'HTML' && f.URL);
    const primary = files[0] || null;
    return {
      docId: item.DocId,
      title: item.Title.trim(),
      summary: item.Summary || '',
      operatingSystems: item.OperatingSystemKeys || [],
      priority: primary?.Priority || 'Recommended',
      file: primary ? {
        name: primary.Name,
        version: primary.Version,
        size: primary.Size,
        url: primary.URL,
        sha256: primary.SHA256 || null,
        sha1: primary.SHA1 || null,
        md5: primary.MD5 || null,
        type: primary.TypeString,
        date: primary.Date?.Unix ? new Date(primary.Date.Unix).toISOString().split('T')[0] : '',
      } : null,
    };
  }).filter(item => item.file !== null);

  return {
    categories: body.AllCategories || [],
    drivers: items,
  };
});

// Pick a download folder
ipcMain.handle('choose-download-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose download folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

function sanitizeName(str) {
  return (str || '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/&/g, 'and')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .trim() || 'driver';
}

function buildDriverPath(destDir, { categoryName, driverName, version, url }) {
  const originalExt = (url.split('/').pop().split('?')[0].match(/\.[^.]+$/) || ['.exe'])[0];
  const folderName = sanitizeName(categoryName || 'Other');
  let fileName;
  if (driverName && version) {
    fileName = `${sanitizeName(driverName)}-v${version}${originalExt}`;
  } else if (driverName) {
    fileName = `${sanitizeName(driverName)}${originalExt}`;
  } else {
    fileName = url.split('/').pop().split('?')[0];
  }
  return path.join(destDir, folderName, fileName);
}

// Check which drivers are already downloaded on disk
ipcMain.handle('check-downloads', async (event, { downloadDir, drivers }) => {
  const result = {};
  for (const d of drivers) {
    const filePath = buildDriverPath(downloadDir, d);
    result[d.docId] = { exists: fs.existsSync(filePath), path: filePath };
  }
  return result;
});

// Delete a single downloaded driver file
ipcMain.handle('delete-download', async (event, filePath) => {
  try {
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Compare two version strings — returns -1 (a older), 0 (equal), 1 (a newer)
function compareVersions(a, b) {
  if (!a || !b) return null;
  const pa = String(a).trim().split('.');
  const pb = String(b).trim().split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] || '0', 10);
    const nb = parseInt(pb[i] || '0', 10);
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else {
      // Fall back to string compare for non-numeric segments (e.g. BIOS "N3CN40WW")
      const sc = String(pa[i] || '').localeCompare(String(pb[i] || ''));
      if (sc !== 0) return sc < 0 ? -1 : 1;
    }
  }
  return 0;
}

// Check installed driver versions on Windows via CIM/registry
ipcMain.handle('check-outdated', async (event, { drivers }) => {
  if (process.platform !== 'win32') {
    throw new Error('Version checking is only supported on Windows');
  }

  // One PowerShell pass — collect all detectable versions as JSON
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$r = @{
  audio      = $null; gpu       = $null; bios      = $null
  wifi       = $null; bluetooth = $null; chipset   = $null
  cardreader = $null; energy    = $null
}
$r.audio = (Get-CimInstance Win32_PnPSignedDriver |
  Where-Object { $_.DeviceClass -eq 'MEDIA' -and $_.DeviceName -like '*Realtek*' } |
  Select-Object -First 1).DriverVersion
$r.gpu = (Get-CimInstance Win32_VideoController |
  Where-Object { $_.Name -like '*AMD*' -or $_.Name -like '*Radeon*' } |
  Select-Object -First 1).DriverVersion
$r.bios = (Get-CimInstance Win32_BIOS).SMBIOSBIOSVersion
$r.wifi = (Get-CimInstance Win32_PnPSignedDriver |
  Where-Object { $_.DeviceClass -eq 'Net' -and
    ($_.Manufacturer -like '*MediaTek*' -or $_.DeviceName -like '*MediaTek*' -or $_.DeviceName -like '*MT79*') } |
  Select-Object -First 1).DriverVersion
$r.bluetooth = (Get-CimInstance Win32_PnPSignedDriver |
  Where-Object { $_.DeviceClass -eq 'Bluetooth' -and
    ($_.Manufacturer -like '*MediaTek*' -or $_.DeviceName -like '*MediaTek*') } |
  Select-Object -First 1).DriverVersion
$r.chipset = (Get-CimInstance Win32_PnPSignedDriver |
  Where-Object { $_.DeviceName -like '*AMD*' -and $_.DeviceClass -eq 'System' } |
  Sort-Object DriverVersion -Descending | Select-Object -First 1).DriverVersion
$r.cardreader = (Get-CimInstance Win32_PnPSignedDriver |
  Where-Object { $_.DeviceClass -eq 'SmartCardReader' -or
    $_.DeviceName -like '*Realtek*Card*' -or $_.DeviceName -like '*Genesys*' } |
  Select-Object -First 1).DriverVersion
$paths = @(
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$r.energy = (Get-ItemProperty $paths |
  Where-Object { $_.DisplayName -like '*Energy*Management*' } |
  Select-Object -First 1).DisplayVersion
ConvertTo-Json $r -Compress
`;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const { stdout } = await execAsync(
    `powershell.exe -NonInteractive -NoProfile -EncodedCommand ${encoded}`,
    { timeout: 45000 }
  );

  let installed = {};
  try { installed = JSON.parse(stdout.trim()); } catch { /* PS returned nothing detectable */ }

  // Map each Lenovo driver name to its detection key
  const NAME_KEY = {
    'Realtek Audio Driver':      'audio',
    'AMD Graphics Driver':       'gpu',
    'BIOS Update':               'bios',
    'Mediatek WLAN Driver':      'wifi',
    'Mediatek Bluetooth Driver': 'bluetooth',
    'AMD Chipset Driver':        'chipset',
    'CardReader Driver':         'cardreader',
    'Lenovo Energy Management':  'energy',
  };

  return drivers.map(d => {
    const key = NAME_KEY[d.name] || null;
    const installedVer = key && installed[key] ? String(installed[key]).trim() : null;
    const lenovoVer = d.version || null;
    const cmp = compareVersions(installedVer, lenovoVer);

    let status = 'unknown';
    if (installedVer && lenovoVer) {
      if (cmp === 0)       status = 'up-to-date';
      else if (cmp < 0)   status = 'outdated';
      else                 status = 'newer';
    } else if (!installedVer) {
      status = 'not-detected';
    }

    return { docId: d.docId, title: d.title, installedVersion: installedVer, lenovoVersion: lenovoVer, status };
  });
});

// Download a single driver with progress reporting and checksum verification
ipcMain.handle('download-driver', async (event, { docId, url, destDir, sha256, sha1, md5, categoryName, driverName, version }) => {
  const categoryDir = path.join(destDir, sanitizeName(categoryName || 'Other'));
  fs.mkdirSync(categoryDir, { recursive: true });
  const destPath = buildDriverPath(destDir, { categoryName, driverName, version, url });

  // Ordered list of checksums to try — strongest first
  const checksums = [
    sha256 ? { algorithm: 'SHA256', nodeAlgo: 'sha256', expected: sha256 } : null,
    sha1   ? { algorithm: 'SHA1',   nodeAlgo: 'sha1',   expected: sha1  } : null,
    md5    ? { algorithm: 'MD5',    nodeAlgo: 'md5',    expected: md5   } : null,
  ].filter(Boolean);

  // Skip download if file already exists and passes the best available checksum
  if (fs.existsSync(destPath) && checksums.length > 0) {
    const best = checksums[0];
    const existing = await hashFile(destPath, best.nodeAlgo);
    if (existing.toLowerCase() === best.expected.toLowerCase()) {
      mainWindow.webContents.send('download-progress', {
        docId, percent: 100, status: 'cached', algorithm: best.algorithm,
      });
      return { success: true, path: destPath, cached: true, algorithm: best.algorithm };
    }
  }

  await new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    const request = (targetUrl) => {
      protocol.get(targetUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          const redirectProto = res.headers.location.startsWith('https') ? https : http;
          redirectProto.get(res.headers.location, { headers: { 'User-Agent': HEADERS['User-Agent'] } }, redirectRes => {
            handleStream(redirectRes);
          }).on('error', reject);
          return;
        }
        handleStream(res);
      }).on('error', reject);
    };

    const handleStream = (res) => {
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;

      res.on('data', chunk => {
        downloaded += chunk.length;
        file.write(chunk);
        if (total > 0) {
          mainWindow.webContents.send('download-progress', {
            docId,
            percent: Math.min(99, Math.round((downloaded / total) * 100)),
            status: 'downloading',
          });
        }
      });
      res.on('end', () => { file.end(); resolve(); });
      res.on('error', reject);
    };

    request(url);
  });

  // Verify against the best available checksum, delete file on mismatch
  if (checksums.length > 0) {
    const { algorithm, nodeAlgo, expected } = checksums[0];
    mainWindow.webContents.send('download-progress', { docId, percent: 99, status: 'verifying', algorithm });
    const actual = await hashFile(destPath, nodeAlgo);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      fs.unlinkSync(destPath);
      throw new Error(`${algorithm} mismatch — file may be corrupted. Expected: ${expected.slice(0, 16)}…`);
    }
    mainWindow.webContents.send('download-progress', { docId, percent: 100, status: 'verified', algorithm });
    return { success: true, path: destPath, algorithm };
  }

  mainWindow.webContents.send('download-progress', { docId, percent: 100, status: 'done' });
  return { success: true, path: destPath, algorithm: null };
});

// Run an installer and wait for it to exit
ipcMain.handle('install-driver', async (event, { docId, filePath }) => {
  return new Promise((resolve) => {
    const ext = path.extname(filePath).toLowerCase();

    let proc;
    if (ext === '.exe') {
      proc = spawn(filePath, ['/VERYSILENT', '/NORESTART', '/SP-'], { detached: true, stdio: 'ignore' });
    } else if (ext === '.msi') {
      proc = spawn('msiexec', ['/i', filePath, '/quiet', '/norestart'], { detached: true, stdio: 'ignore' });
    } else {
      // Fall back to ShellExecute for unknown types
      shell.openPath(filePath);
      resolve({ success: true, manual: true });
      return;
    }

    proc.on('close', code => resolve({ success: code === 0, code }));
    proc.on('error', err => resolve({ success: false, error: err.message }));
  });
});

// Open a folder in Explorer/Finder
ipcMain.handle('open-folder', async (event, folderPath) => {
  shell.openPath(folderPath);
});

// Settings persistence — stored in Electron's userData directory
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(data) {
  const current = loadSettings();
  fs.writeFileSync(getSettingsPath(), JSON.stringify({ ...current, ...data }, null, 2));
}

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (event, data) => { saveSettings(data); });

// Open a URL in the system browser
ipcMain.handle('open-external', async (event, url) => {
  if (/^https:\/\/support\.lenovo\.com\//.test(url)) {
    shell.openExternal(url);
  }
});

// Fetch older (superseded) versions of a driver by docId
ipcMain.handle('fetch-driver-versions', async (event, docId) => {
  const url = `https://pcsupport.lenovo.com/us/en/api/v4/downloads/driver?docId=${encodeURIComponent(docId)}`;
  const response = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const details = response.data?.body?.DriverDetails;
  if (!details) return { older: [] };

  const older = (details.Supersedes || []).map(s => ({
    docId: s.DocId,
    title: s.Title?.trim() || '',
    file: (() => {
      const f = (s.Files || []).find(f => f.TypeString !== 'HTML' && f.URL);
      if (!f) return null;
      return {
        version: f.Version,
        size: f.Size,
        url: f.URL,
        sha256: f.SHA256,
        date: f.Date?.Unix ? new Date(f.Date.Unix).toISOString().split('T')[0] : '',
      };
    })(),
  })).filter(s => s.file !== null);

  return { older };
});

function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
