import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isWin = process.platform === 'win32';
const appDataDir = isWin
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '9router')
  : path.join(os.homedir(), '.9router');

const currentPid = process.pid;
const parentPid = process.ppid;

// 1. Graceful shutdown via HTTP endpoint
async function gracefulShutdown() {
  const ports = [20128, 20127];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);

  try {
    await Promise.allSettled(
      ports.map(async (port) => {
        try {
          await fetch(`http://127.0.0.1:${port}/api/version/shutdown`, {
            method: 'POST',
            signal: controller.signal,
          });
        } catch {}
      })
    );
  } finally {
    clearTimeout(timeout);
  }

  // Grace period for server to clean up and exit
  await new Promise((r) => setTimeout(r, 600));
}

// 2. Kill PID files (mitm, tunnel)
function killPidFiles() {
  const pidFiles = [
    path.join(appDataDir, 'mitm', '.mitm.pid'),
    path.join(appDataDir, 'tunnel', 'cloudflared.pid'),
    path.join(appDataDir, 'tunnel', 'tailscale.pid'),
  ];

  for (const file of pidFiles) {
    try {
      if (!fs.existsSync(file)) continue;
      const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      if (pid && !isNaN(pid) && pid !== currentPid && pid !== parentPid) {
        try {
          if (isWin) {
            execSync(`taskkill /F /T /PID ${pid} 2>nul`, { stdio: 'ignore', windowsHide: true, timeout: 2000 });
          } else {
            process.kill(pid, 'SIGKILL');
          }
        } catch {}
      }
      try { fs.unlinkSync(file); } catch {}
    } catch {}
  }
}

// 3. Kill remaining processes on ports 20127 and 20128
function killPortProcesses() {
  const ports = [20127, 20128];
  for (const port of ports) {
    try {
      if (isWin) {
        const out = execSync(`netstat -ano | findstr :${port}`, {
          encoding: 'utf8',
          shell: true,
          windowsHide: true,
          timeout: 3000,
        });
        const lines = out.split('\n').filter((l) => l.includes('LISTENING'));
        for (const line of lines) {
          const pid = parseInt(line.trim().split(/\s+/).pop(), 10);
          if (pid && !isNaN(pid) && pid !== currentPid && pid !== parentPid) {
            try {
              execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: 'ignore', windowsHide: true, timeout: 2000 });
            } catch {}
          }
        }
      } else {
        const out = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
        if (out) {
          out.split('\n').forEach((line) => {
            const pid = parseInt(line.trim(), 10);
            if (pid && !isNaN(pid) && pid !== currentPid && pid !== parentPid) {
              try { process.kill(pid, 'SIGKILL'); } catch {}
            }
          });
        }
      }
    } catch {}
  }
}

// 4. Kill remaining 9router processes (binaries & node wrappers)
function killAppProcesses() {
  if (isWin) {
    try { execSync('taskkill /F /IM 9router.exe 2>nul', { stdio: 'ignore', windowsHide: true, timeout: 2000 }); } catch {}
    try { execSync('taskkill /F /IM tray_windows_release.exe 2>nul', { stdio: 'ignore', windowsHide: true, timeout: 2000 }); } catch {}

    try {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation`;
      const out = execSync(`powershell -NoP -C "${ps}"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 5000,
      });

      for (const line of out.split('\n')) {
        const match = line.match(/^"(\d+)","(.*)"$/);
        if (!match) continue;
        const pid = parseInt(match[1], 10);
        const cmd = match[2].toLowerCase();

        if (pid === currentPid || pid === parentPid) continue;
        if (cmd.includes('npm-cli.js') || cmd.includes('shutdown.mjs')) continue;

        const isAppProcess =
          (cmd.includes('9router') && (cmd.includes('cli.js') || cmd.includes('\\cli') || cmd.includes('/cli') || cmd.includes('custom-server.js'))) ||
          cmd.includes('next-server') ||
          cmd.includes('mitm\\server') ||
          cmd.includes('mitm/server');

        if (isAppProcess) {
          try { execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: 'ignore', windowsHide: true, timeout: 2000 }); } catch {}
        }
      }
    } catch {}
  } else {
    try { execSync("pkill -f 'tray_darwin|tray_linux' 2>/dev/null || true", { stdio: 'ignore', timeout: 2000 }); } catch {}

    try {
      const out = execSync('ps -eo pid,ppid,command 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const cmd = parts.slice(2).join(' ').toLowerCase();

        if (pid === currentPid || pid === parentPid || ppid === currentPid) continue;
        if (cmd.includes('npm-cli.js') || cmd.includes('shutdown.mjs')) continue;

        const isAppProcess =
          (cmd.includes('9router') && (cmd.includes('cli.js') || cmd.includes('/cli') || cmd.includes('custom-server.js'))) ||
          cmd.includes('next-server') ||
          cmd.includes('mitm/server');

        if (isAppProcess) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      }
    } catch {}
  }
}

async function main() {
  console.log('Shutting down 9router...');
  await gracefulShutdown();
  killPidFiles();
  killPortProcesses();
  killAppProcesses();
  console.log('9router stopped.');
}

main().catch(() => {
  process.exit(0);
});
