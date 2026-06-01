function getMitmAutoStartState(settings = {}) {
  const hasMitmAutoStart = Object.prototype.hasOwnProperty.call(settings, "mitmAutoStartEnabled");
  const hasDnsAutoStart = Object.prototype.hasOwnProperty.call(settings, "dnsToolAutoStartEnabled");
  const dnsToolAutoStartEnabled = hasDnsAutoStart
    ? { ...(settings.dnsToolAutoStartEnabled || {}) }
    : { ...(settings.dnsToolEnabled || {}) };

  return {
    mitmAutoStartEnabled: hasMitmAutoStart
      ? settings.mitmAutoStartEnabled === true
      : settings.mitmEnabled === true,
    dnsToolAutoStartEnabled,
    antigravityDnsAutoStartEnabled: dnsToolAutoStartEnabled.antigravity === true,
  };
}

function buildNextToolAutoStartSettings(settings = {}, tool, enabled) {
  const current = getMitmAutoStartState(settings);
  const nextDnsToolAutoStartEnabled = {
    ...current.dnsToolAutoStartEnabled,
    [tool]: enabled === true,
  };
  const anyToolEnabled = Object.values(nextDnsToolAutoStartEnabled).some(Boolean);

  return {
    mitmAutoStartEnabled: enabled === true ? true : anyToolEnabled,
    dnsToolAutoStartEnabled: nextDnsToolAutoStartEnabled,
  };
}

module.exports = {
  getMitmAutoStartState,
  buildNextToolAutoStartSettings,
};
