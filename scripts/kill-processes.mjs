import { execSync } from 'child_process';

// Kill running 9router instances before update to release file locks on Windows
try {
  if (process.platform === 'win32') {
    try { execSync('taskkill /F /IM 9router.exe 2>nul'); } catch {}

    const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation`;
    const out = execSync(`powershell -NoP -C "${ps}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const currentPid = process.pid;
    const parentPid = process.ppid;

    for (const line of out.split('\n')) {
      const match = line.match(/^"(\d+)","(.*)"$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      const cmd = match[2].toLowerCase();

      if (pid === currentPid || pid === parentPid) continue;
      if (cmd.includes('npm-cli.js')) continue;

      const isAppProcess =
        (cmd.includes('9router') && (cmd.includes('cli.js') || cmd.includes('\\cli') || cmd.includes('/cli'))) ||
        cmd.includes('next-server') ||
        cmd.includes('mitm/server') ||
        cmd.includes('mitm\\server');

      if (isAppProcess) {
        try { execSync(`taskkill /F /PID ${pid} 2>nul`); } catch {}
      }
    }
  } else {
    try { execSync("pkill -f '(9router.*cli\\.js|next-server|mitm/server)' 2>/dev/null || true"); } catch {}
  }
} catch {
  // Ignore errors to ensure update continues
}
