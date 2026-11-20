'use strict';
/**
 * Android System Settings: no need to enter Android desktops, no need to install third party tools,
 * Directly through adb to make a common system switch into a button on the Hydra Emulator setup page.
 * All orders are official shell interfaces, not dependent on root.
 */
const ACTIONS = {
  settings: 'android.settings.SETTINGS',
  wifi: 'android.settings.WIFI_SETTINGS',
  display: 'android.settings.DISPLAY_SETTINGS',
  sound: 'android.settings.SOUND_SETTINGS',
  locale: 'android.settings.LOCALE_SETTINGS',
  date: 'android.settings.DATE_SETTINGS',
  apps: 'android.settings.APPLICATION_SETTINGS',
  storage: 'android.settings.INTERNAL_STORAGE_SETTINGS',
  battery: 'android.settings.BATTERY_SAVER_SETTINGS',
  cast: 'android.settings.CAST_SETTINGS',
  dev: 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS',
};

/**
 * Volume orders for the STREAM_MUSIC = 3. Android 11 systems dropped `media` Tools
 * (The same function. `cmd media_session volume` Lee;
 * When the old mirror doesn’t have it, we’ll return it. `media volume`.
 */
function volumeCmd(args) {
  return `(cmd media_session volume --stream 3 ${args} || media volume --stream 3 ${args})`;
}

/** Parsing `volume --get` the output of, for example `volume is 5 in range [0..15]` */
function parseVolume(out) {
  const m = /volume is (\d+) in range \[(\d+)\.\.(\d+)\]/.exec(String(out || ''));
  if (!m) return null;
  return { index: Number(m[1]), min: Number(m[2]), max: Number(m[3]) };
}

/** As a percentage of the interface */
function volumePercent(v) {
  if (!v || v.max <= v.min) return 0;
  return Math.round(((v.index - v.min) / (v.max - v.min)) * 100);
}

class AndroidSettings {
  constructor(runtime) { this.runtime = runtime; }

  async client() {
    const rt = await this.runtime.ensure();
    if (!rt.ok) throw new Error(rt.error || 'Run Not Ready');
    return rt.client;
  }

  async _sh(commands) {
    const c = await this.client();
    const script = commands.map((x) => `${x}; `).join('');
    return c.shell(script, { timeout: 20000 });
  }

  /** Read a group of current states to set the page display */
  async status() {
    const out = await this._sh([
      'echo "wifi=$(settings get global wifi_on)"',
      'echo "air=$(settings get global airplane_mode_on)"',
      'echo "font=$(settings get system font_scale)"',
      'echo "density=$(wm density | tail -n1 | tr -dc \'0-9\')"',
      'echo "animw=$(settings get global window_animation_scale)"',
      'echo "sdk=$(getprop ro.build.version.sdk)"',
      `echo "vol=$(${volumeCmd('--get')} 2>/dev/null | grep -m1 'volume is')"`,
    ]);
    const get = (k) => {
      const m = new RegExp(`${k}=([^\\r\\n]*)`).exec(String(out));
      return m ? m[1].trim() : '';
    };
    const anim = get('animw');
    return {
      wifi: get('wifi') === '1',
      airplane: get('air') === '1',
      fontScale: Number(get('font')) || 1,
      density: Number(get('density')) || 0,
      volume: volumePercent(parseVolume(get('vol'))),
      animationsOff: anim === '0.0' || anim === '0',
      sdk: Number(get('sdk')) || 0,
    };
  }

  async setWifi(on) {
    await this._sh([`svc wifi ${on ? 'enable' : 'disable'}`]);
    return { ok: true };
  }

  async setAirplane(on) {
    const v = on ? 1 : 0;
    await this._sh([
      `settings put global airplane_mode_on ${v}`,
      `am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${on ? 'true' : 'false'}`,
      `svc wifi ${on ? 'disable' : 'enable'}`,
      `svc data ${on ? 'disable' : 'enable'}`,
    ]);
    return { ok: true };
  }

  /**
   * Volume: The interface is given as a percentage of 0-100, and the system is looking for the media stream (commonly 0-15, different mirrors)),
   * So, read the strategist and convert.
   */
  async setVolume(percent) {
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const range = parseVolume(await this._sh([`${volumeCmd('--get')} 2>/dev/null`])) || { min: 0, max: 15 };
    const index = Math.round(range.min + ((range.max - range.min) * p) / 100);
    await this._sh([volumeCmd(`--set ${index}`)]);
    return { ok: true, volume: volumePercent({ ...range, index }) };
  }

  /** Close System Animation = Visible "Accelerator" with little loss of functionality */
  async setAnimations(on) {
    const v = on ? '1' : '0';
    await this._sh([
      `settings put global window_animation_scale ${v}`,
      `settings put global transition_animation_scale ${v}`,
      `settings put global animator_duration_scale ${v}`,
    ]);
    return { ok: true, animationsOff: !on };
  }

  async setFontScale(scale) {
    const v = Math.max(0.85, Math.min(1.3, Number(scale) || 1)).toFixed(2);
    await this._sh([`settings put system font_scale ${v}`]);
    return { ok: true, fontScale: Number(v) };
  }

  /** Show size: Change dpi, larger content (equivalent to system "Small Size" slots)) */
  async setDensity(dpi) {
    const v = Math.max(120, Math.min(640, Math.round(Number(dpi) || 0)));
    if (!v) return { ok: false };
    await this._sh([`wm density ${v}`]);
    return { ok: true, density: v };
  }

  /** One key: turn animated + off telemetry services + battery white list to make the application more hand-friendly */
  async tune({ pkg } = {}) {
    const cmds = [
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put global activity_manager_constants max_cached_processes=32',
    ];
    if (pkg) cmds.push(`dumpsys deviceidle whitelist +${pkg}`);
    await this._sh(cmds);
    return { ok: true };
  }

  async open(action) {
    const a = ACTIONS[action] || ACTIONS.settings;
    const c = await this.client();
    await c.shell(`am start -a ${a}`, { timeout: 15000 });
    return { ok: true };
  }

  /** Apply RunAppearance + Authorization */
  async permissions(pkg) {
    const c = await this.client();
    const dump = await c.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const rows = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break;
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m) rows.push({ name: m[1], granted: m[2] === 'true' });
    }
    return rows;
  }

  async grantAll(pkg) {
    const c = await this.client();
    const rows = await this.permissions(pkg);
    const denied = rows.filter((r) => !r.granted).map((r) => r.name);
    for (const p of denied) {
      // eslint-disable-next-line no-await-in-loop
      await c.shell(`pm grant ${pkg} ${p}`, { timeout: 8000 }).catch(() => {});
    }
    return { ok: true, granted: denied.length };
  }
}

module.exports = { AndroidSettings, ACTIONS, volumeCmd, parseVolume, volumePercent };
