const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, execSync } = require("child_process");

const APP_NAME = "9router";
const APP_LABEL = "com.9router.autostart";
const WINDOWS_TASK_PREFIX = "9Router Auto-start";

/**
 * Resolve the absolute path to this package's cli.js.
 *
 * Order of preference:
 *   1. Explicit `cliPath` argument — cleanest, used when called from running
 *      cli.js with `__filename`.
 *   2. `process.argv[1]` if it's our cli.js — true when 9router is currently
 *      running and the tray menu fires this code path.
 *   3. Compute relative to this file's own location. autostart.js lives at
 *      `<pkg>/src/cli/tray/autostart.js`, so cli.js is three levels up.
 *      This works for any global install layout (nvm, Volta, asdf, Homebrew,
 *      /usr/local, etc.) without depending on `npm bin -g` (removed in npm 9)
 *      or a hardcoded `/usr/local/...` path.
 *
 * Returns null if no candidate exists — callers should not write an autostart
 * entry pointing at a non-existent script.
 */
function getCliJsPath(cliPath) {
  if (cliPath) {
    const resolved = path.resolve(cliPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  if (process.argv[1]) {
    const resolved = path.resolve(process.argv[1]);
    if (path.basename(resolved) === "cli.js" && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  const computed = path.resolve(__dirname, "..", "..", "..", "cli.js");
  if (fs.existsSync(computed)) return computed;
  return null;
}

/**
 * Enable auto startup on OS boot
 * @param {string} cliPath - Optional path to cli.js (defaults to auto-detect)
 * @returns {boolean} success
 */
function enableAutoStart(cliPath) {
  const platform = process.platform;

  if (!["darwin", "win32", "linux"].includes(platform)) return false;
  if (platform === "linux" && !process.env.DISPLAY) return false;

  try {
    if (platform === "darwin") return enableMacOS(cliPath);
    if (platform === "win32") return enableWindows(cliPath);
    if (platform === "linux") return enableLinux(cliPath);
  } catch (err) {
    // Silent fail — autostart is optional
  }
  return false;
}

/**
 * Disable auto startup
 * @returns {boolean} success
 */
function disableAutoStart() {
  const platform = process.platform;
  try {
    if (platform === "darwin") return disableMacOS();
    if (platform === "win32") return disableWindows();
    if (platform === "linux") return disableLinux();
  } catch (err) {}
  return false;
}

/**
 * Check if autostart is enabled.
 *
 * On macOS, both the plist file and the launchd registration must be present —
 * otherwise the tray menu would lie about the state (showing "✓ Enabled" even
 * when launchd has the agent in a failed state or hasn't loaded it).
 */
function isAutoStartEnabled() {
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);
      if (!fs.existsSync(plistPath)) return false;
      try {
        execSync(`launchctl list ${APP_LABEL}`, {
          stdio: ["ignore", "ignore", "ignore"],
          timeout: 3000
        });
        return true;
      } catch (e) {
        return false;
      }
    } else if (platform === "win32") {
      return isWindowsTaskEnabled();
    } else if (platform === "linux") {
      const desktopPath = path.join(os.homedir(), ".config", "autostart", `${APP_NAME}.desktop`);
      return fs.existsSync(desktopPath);
    }
  } catch (e) {}
  return false;
}

// ============ macOS ============

/**
 * Returns true when the current Node process IS the running instance that
 * launchd is managing under our agent label.
 *
 * `launchctl unload <plist>` (and `load`) for an Aqua user-domain agent sends
 * SIGTERM to the running process. When the running 9router cli.js was itself
 * spawned by the autostart launchd agent (i.e. user enabled autostart at
 * some point, then rebooted, then clicked the tray icon's "Disable
 * Auto-start" menu item), an unload would kill the very process executing
 * the click handler — and the tray icon would disappear instead of the menu
 * label flipping back to "Enable Auto-start". This helper lets the enable
 * and disable paths sidestep that by skipping launchctl when we'd otherwise
 * be killing ourselves.
 */
function isAgentSelfMacOS() {
  try {
    const output = execSync(`launchctl list ${APP_LABEL}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    return !!(match && parseInt(match[1], 10) === process.pid);
  } catch (e) {
    return false;
  }
}

function enableMacOS(cliPath) {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${APP_LABEL}.plist`);

  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  // Don't write a broken plist that references a non-existent script.
  if (!routerScript) return false;

  // Invoke node + cli.js directly with absolute paths — no shell wrapper.
  // The previous design ran `zsh -l -c "..."` so a login shell would source
  // nvm/.zshrc and set PATH; that's fragile (nvm.sh sourcing varies by user,
  // some setups don't put node on PATH from a non-interactive login shell).
  // EnvironmentVariables.PATH explicitly includes node's bin dir so child
  // processes spawned by cli.js (npm install at runtime, etc.) resolve.
  const launchPath = `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`;

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${APP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${routerScript}</string>
        <string>--tray</string>
        <string>--skip-update</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${launchPath}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/9router.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/9router.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plistContent);

  // If we're the running agent already, launchctl unload/load would send
  // ourselves SIGTERM. Skip it — the plist file is updated on disk and
  // launchd will pick it up at next login. isAutoStartEnabled() will still
  // return true because launchctl already has the agent loaded.
  if (isAgentSelfMacOS()) {
    return true;
  }

  // Register with launchd in the current session. Without this, the agent
  // only takes effect on the next user login and the user has no signal that
  // anything actually happened. `unload` first defends against re-enable
  // replacing an existing plist.
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch (e) {}
  try {
    execSync(`launchctl load -w "${plistPath}"`, { stdio: "ignore" });
  } catch (e) {
    // Even if load fails, the plist is on disk and will be picked up at next
    // login; report success based on the file write.
  }
  return true;
}

function disableMacOS() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);

  // Don't kill ourselves: when the current process is the running agent,
  // `launchctl unload` would send SIGTERM and the user clicking
  // "Disable Auto-start" from the tray menu would lose their tray icon
  // instead of just flipping the menu label. Skip the unload — removing the
  // plist file is enough to prevent the agent from starting on next login.
  if (!isAgentSelfMacOS()) {
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
    } catch (e) {}
  }

  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
  }
  return true;
}

// ============ Windows ============

function getWindowsLegacyVbsPath() {
  return path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    `${APP_NAME}.vbs`
  );
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script, elevated = false) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encoded
  ];

  if (!elevated || isWindowsAdmin()) {
    execFileSync("powershell.exe", args, {
      stdio: "ignore",
      timeout: 30000,
      windowsHide: true
    });
    return;
  }

  // This UAC prompt is required only while creating/removing the task. The task
  // itself starts with a highest-privilege token at future Windows logins.
  const wrapper = `
    $ErrorActionPreference = 'Stop'
    try {
      $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
        '-EncodedCommand','${encoded}'
      ) -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
      if ($null -eq $process) { exit 1 }
      exit $process.ExitCode
    } catch {
      Write-Error $_
      exit 1
    }
  `;
  const wrapperEncoded = Buffer.from(wrapper, "utf16le").toString("base64");
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", wrapperEncoded
  ], {
    stdio: "ignore",
    timeout: 120000,
    windowsHide: true
  });
}

function isWindowsAdmin() {
  try {
    const command = [
      "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
      "$principal = New-Object Security.Principal.WindowsPrincipal($identity)",
      "$admin = [Security.Principal.WindowsBuiltInRole]::Administrator",
      "if ($principal.IsInRole($admin)) { exit 0 } else { exit 1 }"
    ].join("; ");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

function isCurrentWindowsUserAdminMember() {
  try {
    const whoamiPath = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "whoami.exe"
    );
    const groups = execFileSync(whoamiPath, ["/groups", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true
    });
    // Unelevated administrator tokens list this SID as "deny only"; its
    // presence still means Task Scheduler can request the full token at logon.
    return groups.includes("S-1-5-32-544");
  } catch {
    return false;
  }
}

function getCurrentWindowsIdentity() {
  try {
    const command = [
      "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
      "Write-Output ($identity.Name + '|' + $identity.User.Value)"
    ].join("; ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true
    }).trim();
    const separator = output.lastIndexOf("|");
    if (separator <= 0) return null;
    return {
      name: output.slice(0, separator),
      sid: output.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

function getWindowsTaskName(identity = getCurrentWindowsIdentity()) {
  if (!identity?.sid) return null;
  return `${WINDOWS_TASK_PREFIX} ${identity.sid}`;
}

function getWindowsTaskXml(taskName = getWindowsTaskName()) {
  if (!taskName) return null;
  try {
    return execFileSync("schtasks.exe", ["/Query", "/TN", taskName, "/XML"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true
    });
  } catch {
    return null;
  }
}

function isWindowsTaskEnabled() {
  const xml = getWindowsTaskXml();
  if (!xml) return false;

  // Task Scheduler XML may omit Settings/Enabled because true is the default.
  const settings = xml.match(/<Settings[^>]*>([\s\S]*?)<\/Settings>/i)?.[1] || "";
  const enabled = settings.match(/<Enabled>(true|false)<\/Enabled>/i)?.[1];
  return enabled ? enabled.toLowerCase() === "true" : true;
}

function enableWindows(cliPath) {
  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  const identity = getCurrentWindowsIdentity();
  const taskName = getWindowsTaskName(identity);
  if (!routerScript || !identity || !taskName) return false;
  if (!isCurrentWindowsUserAdminMember()) {
    throw new Error("Windows auto-start as Admin requires the current user to be an Administrator");
  }

  // The encoded action keeps the console hidden and avoids command-line quoting
  // problems for Node/NVM/npm paths containing spaces or apostrophes.
  const launchScript = `& ${quotePowerShell(nodePath)} ${quotePowerShell(routerScript)} --tray --skip-update`;
  const launchEncoded = Buffer.from(launchScript, "utf16le").toString("base64");
  const actionArgs = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${launchEncoded}`;
  const taskScript = `
    $ErrorActionPreference = 'Stop'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quotePowerShell(actionArgs)} -WorkingDirectory ${quotePowerShell(path.dirname(routerScript))}
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ${quotePowerShell(identity.name)}
    $principal = New-ScheduledTaskPrincipal -UserId ${quotePowerShell(identity.name)} -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName ${quotePowerShell(taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  `;

  runPowerShell(taskScript, true);

  if (!isWindowsTaskEnabled()) {
    throw new Error("Windows auto-start task was not registered or is disabled");
  }

  // Migrate the previous non-admin Startup entry only after task verification.
  try { fs.unlinkSync(getWindowsLegacyVbsPath()); } catch {}
  return true;
}

function disableWindows() {
  const taskName = getWindowsTaskName();
  if (!taskName) return false;

  const taskScript = `
    $ErrorActionPreference = 'Stop'
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq ${quotePowerShell(taskName)} })
    if ($tasks.Count -gt 0) {
      $tasks | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop
    }
    $remaining = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq ${quotePowerShell(taskName)} })
    if ($remaining.Count -gt 0) {
      throw 'Windows auto-start task could not be removed'
    }
  `;
  runPowerShell(taskScript, true);

  try { fs.unlinkSync(getWindowsLegacyVbsPath()); } catch {}
  return true;
}

// ============ Linux ============

function enableLinux(cliPath) {
  const autostartDir = path.join(os.homedir(), ".config", "autostart");
  const desktopPath = path.join(autostartDir, `${APP_NAME}.desktop`);

  if (!fs.existsSync(autostartDir)) {
    try { fs.mkdirSync(autostartDir, { recursive: true }); }
    catch (e) { return false; }
  }

  const nodePath = process.execPath;
  const routerScript = getCliJsPath(cliPath);
  if (!routerScript) return false;

  const desktopContent = `[Desktop Entry]
Type=Application
Name=9Router
Comment=9Router API Proxy
Exec=${nodePath} ${routerScript} --tray --skip-update
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
  fs.writeFileSync(desktopPath, desktopContent);
  return true;
}

function disableLinux() {
  const desktopPath = path.join(os.homedir(), ".config", "autostart", `${APP_NAME}.desktop`);
  if (fs.existsSync(desktopPath)) {
    fs.unlinkSync(desktopPath);
  }
  return true;
}

module.exports = {
  enableAutoStart,
  disableAutoStart,
  isAutoStartEnabled
};
