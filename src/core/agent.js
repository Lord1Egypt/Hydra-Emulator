'use strict';
/**
 * Windows window agent: communication with permanent processes in src/ core/ win/agent.ps1.
 *
 * Why don’t you always resize every time you drag a PowerShell with the mouse?,
 * Every time a powershell.exe takes 150 to 300 ms, it drags a meal.
 * It’s only started once, and then it’s back to TCP (a JSON in one row), one trip to <2ms.
 *
 * Proxy can choose to be responsible for the WH_MOUSE_LL mouse hook: right key returns / roller slide / side key moves forward and backwards.
 * The hook is global, it intervenes in every mouse event in the system, so it's only "Application window is at the front desk."
 * And at least one map is installed, the focal is off-loaded immediately; the echoes only deal with the seven messages we care about.
 * See setHooks (on, opts).
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');
const CALL_TIMEOUT = 6000;

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.buf = '';
    this.pending = [];
    this.dead = false;
    this.hooked = false;
    this.hookConf = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(SCRIPT); }

  /** Start proxy and wait for TCP to be connected.) */
  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!this.available) { reject(new Error('Window Proxy Not Available')); return; }
      let out = '';
      let settled = false;
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc = proc;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onData = (chunk) => {
        out += chunk.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        settled = true;
        this.port = Number(m[1]);
        this._connect().then(resolve).catch(fail);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
      proc.on('error', fail);
      proc.on('exit', () => {
        const wasReady = !!this.sock;
        this.proc = null;
        this.sock = null;
        this.ready = null;
        this.hooked = false;
        this.hookConf = null;
        this._failAll('Window Agent Exited');
        if (wasReady) this.emit('exit');
        fail(new Error('Window proxy startup failed'));
      });
      setTimeout(() => { if (!settled) fail(new Error('Window Agent Start Timeout')); }, 15000);
    });
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(this));
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { reject(e); });
      sock.on('close', () => {
        this.sock = null;
        this.ready = null;
        this._failAll('Window proxy connection is disconnected');
      });
      this.sock = sock;
      this.buf = '';
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      // Event load (dx/dy/nx/ny on wheels), old listener ignores excess parameters
      if (msg.ev) { this.emit(msg.ev, msg); continue; }
      const p = this.pending.shift();
      if (p) { clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** Send an order and wait to return the bag */
  async call(obj, timeout = CALL_TIMEOUT) {
    await this.ensure();
    if (!this.sock) throw new Error('Window Agent Not Connected');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Window Agent Timeout: ${obj.cmd}`)), timeout);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(`${JSON.stringify(obj)}\n`);
    });
  }

  // ------------------------------ --------------------------------------------------------------------------------------------------------------

  /**
   * The statement says, "What's the process in the directory for us?"
   * The window agent must be called before the bootHide/ embed: only the windows created by these processes are allowed to touch.
   * No (or empty) proxy window moves without sending -- prefers to occasionally leak a black window.,
   * Nor do you hide or embed windows of other Qt applications (Vict 4.x is Qt6, Mumu, music player).
   * @param{string[} root directory when running dirs / packaged engine directory
   * @param{number} [appPid] Master process pid: Agent only allows the window to be embedded in the window of the process,
   *        And on this basis, it is decided whether the current window of the mouse event is ours.)
   */
  async scope(dirs, appPid) {
    /**
     * Directory must be resolved**Real Path**I’ll give it to the agent.
     *
     * Proxy is based on the “Process executable path prefix“ for the window, and Windows
     * `Process.MainModule.FileName` Returns the true path of the junction/ symbol link.
     * If Hydra Emulator started itself from a directory connection (e.g., a list)\Hydra Emulator-win64-portable
     * Link to Build\_packout\...), It’s still the link path to the agent, and the prefix doesn’t match. →
     * The agent thought, “This is not our process,“ but he couldn’t find the emu window.)→
     * The primary window takes over failed back to embedded mode, and the user sees the shell window with the spin button.
     * Both paths are retained: the real path is used to match, the original path is compatible with very few environments that return the link path.
     */
    const raw = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const list = [];
    for (const d of raw) {
      try {
        const real = fs.realpathSync.native ? fs.realpathSync.native(d) : fs.realpathSync(d);
        if (real) list.push(real);
      } catch (_) { /* If the directory does not exist, just leave the original path. */ }
      list.push(d);
    }
    const uniq = [...new Set(list.filter(Boolean))];
    const req = { cmd: 'scope', dirs: uniq.join(';') };
    if (Number(appPid) > 0) req.pid = Number(appPid);
    return this.call(req, 4000).catch(() => ({ ok: false, n: 0 }));
  }

  /**
   * Embedded the image window into the host’s window and placed in x,y,w,h (coordinate of host client area).
   *
   * @param {number|hostHwnd host window handle
   * @param {object} rect { x, y, w, h, clipTop }
   * @param{string} [targets] The list of candidates for the third-party background ("0x...")
   *        Do not send = Old Behaviour: The proxy will find the window with the emulator by process field.
   *        Passed = Only one of these handles (mmu/ other simulator image window).
   */
  async embed(hostHwnd, rect, targets = null) {
    const req = {
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    };
    if (Array.isArray(targets) && targets.length) {
      req.target = targets.map((t) => String(t)).join(',');
    }
    return this.call(req, 6000);
  }

  /** There are still a few of them.) */
  async windowReady(targets = []) {
    if (!Array.isArray(targets) || !targets.length) return { ok: false, alive: 0 };
    return this.call({ cmd: 'winready', target: targets.join(',') }, 3000)
      .catch(() => ({ ok: false, alive: 0 }));
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      // The emulator Qt window is more external than the LCD, and we’re going to make it go up/left and spill this frame.
      // Squeeze out of the client area; the one spilling out to the titlebar will be cut (or the headbar button will be blacked out).
      clipTop: Math.round(rect.clipTop || 0),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  /** Notification agent into low delay mode: significantly lower window scanning frequency and leave CPU to Android for rewrite */
  async setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  /** @param{boolean} keep true= cut to stand-alone window mode (don’t hide the simulator window and keep the handle on it)) */
  async detach(keep = false) { return this.call({ cmd: 'detach', keep: keep ? 1 : 0 }, 5000); }
  /** Separate window mode: Place the emulator’s original window to the specified screen rectangle (not embedded)) */
  async layout(rect) {
    return this.call({
      cmd: 'layout',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    }, 4000);
  }
  /**
   * Change the title of the simulator’s original window from "Android Emulator - HYDRA:5554" to a user’s comprehensible name.
   * "Hydra Emulator" is defaulted when passing an empty string. The agent will continue to reset it in the inspector’s office.
   */
  async setTitle(text = 'Hydra Emulator') {
    return this.call({ cmd: 'title', text: String(text || 'Hydra Emulator') }, 4000);
  }
  /**
   * Set icons for the emulator primary window (taskbar under stand-alone window mode/ Alt+Tab displays the current application icon).
   * @param{string} file PNG/ ICO absolute path
   */
  async setIcon(file) {
    return this.call({ cmd: 'icon', file: String(file || '') }, 4000);
  }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }
  /** Lists the current visible top-level windows (for validation of “software interface only / Android only application window)) */
  async windows() { return this.call({ cmd: 'windows' }, 4000); }

  /**
   * Remove the number one suspect window and hide it.
   * The host window must be called before it is destroyed: Windows will reload the cross-process subwindow to the desktop when the parent window is destroyed,
   * And to keep it visible -- that’s how the Android Emulator black window comes out of thin air on the desktop.
   * Agent’s busy, and he can’t keep his window open, so he gives 700ms a hard ceiling.
   */
  async park(maxWaitMs = 700) {
    const call = this.call({ cmd: 'park' }, 2000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /**
   * Open "Residence Repression": Simulator Main Window (QWindowIcon)+Toolbar + qemu / Netsimd Black Window
   * No one is allowed to appear, except the one who was embed into our window.
   * This is the key to "open software only to see software interfaces": emulator pulls up qemu / netsimd
   * Control table processes, Node’s WindowsHide does not cover them, only by the window proxy cyclical pressure.
   * Now, the simulator is still wearing -qt-hide-window, double insured, not even the first frame.
   *
   * MAXWaitMs: The agent itself is required to compile the start-up now (a few hundred milliseconds, possibly ten seconds in an anomaly).
   * “Before the simulator is pulled up, it's not important to have a hard ceiling here because the agent can't hold the switch.
   * @param {number} maxWaitMs
   */
  async bootHide(maxWaitMs = 3000) {
    const call = this.call({ cmd: 'boothide', on: 1 }, 4000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /** Turn off the permanent suppression (normally no longer required): Embedding will automatically skip the embedded window) */
  async bootShow() {
    return this.call({ cmd: 'boothide', on: 0 }, 4000).catch(() => ({ ok: false }));
  }

  /**
   * Global mouse hook switch (scoffs).
   * Install only when applying the front desk of the window and at least one map is open; opts changes without reloading the thread,
   * Only new switches are sent to the resident agent to avoid repeated handle hooks when the window is changed.
   * @param {boolean} on
   * @param {{rightBack?:boolean, wheel?:boolean, side?:boolean}} opts
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const conf = {
      right: !!(opts && opts.rightBack),
      wheel: !!(opts && opts.wheel),
      side: !!(opts && opts.side),
    };
    // Do not pull the PowerShell process for "off" during the default shutdown (cold start zero cost))
    if (!want && !this.hooked) return { ok: true, hooked: false };
    const sameConf = this.hookConf
      && this.hookConf.right === conf.right
      && this.hookConf.wheel === conf.wheel
      && this.hookConf.side === conf.side;
    if (want === this.hooked && sameConf) return { ok: true, hooked: this.hooked };
    const req = { cmd: 'hook', on: want ? 1 : 0, right: conf.right ? 1 : 0, wheel: conf.wheel ? 1 : 0, side: conf.side ? 1 : 0 };
    if (!want) {
      this.hooked = false;
      this.hookConf = null;
      return this.call(req, 3000).catch(() => ({ ok: false, hooked: false }));
    }
    const r = await this.call(req, 3000).catch(() => null);
    this.hooked = !!(r && r.hooked !== false);
    this.hookConf = this.hooked ? conf : null;
    return { ok: this.hooked, hooked: this.hooked };
  }

  dispose() {
    // Unload the whole hook before finish the process: even if the agent is killed, no residual hooks are left in the system.
    if (this.hooked && this.sock) {
      try { this.sock.write('{"cmd":"hook","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.hooked = false;
    this.hookConf = null;
    try { this.sock?.end(); } catch (_) { /* ignore */ }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    // Deliberately not kill proxy process: Disconnected it will enter its own "guard" state (see agent. ps1)
    // _lingerUntil). Simulators may still be active, and dozens of seconds later show up the window; if
    // The agent is dead, and a Android Emulator black window will be left on the desktop.
    // The agent will quit on his own, for a maximum of three minutes.
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
