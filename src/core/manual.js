'use strict';

// The anchors match the generated headings in src/ui/manual.html.
const TOPICS = Object.freeze({
  overview: { id: 'overview', anchor: 'hydra-emulator-user-manual', title: 'User Manual' },
  accel: { id: 'accel', anchor: '6-1-hardware-acceleration-unavailable', title: 'Hardware acceleration unavailable' },
  install: { id: 'install', anchor: '6-2-apk-installation-errors', title: 'APK installation errors' },
  arm: { id: 'arm', anchor: '6-3-arm-apps-fail-or-crash', title: 'ARM apps fail or crash' },
  adb: { id: 'adb', anchor: '6-4-adb-authorization', title: 'ADB authorization' },
  startup: { id: 'startup', anchor: '6-5-app-shortcut-or-window-fails-to-open', title: 'App shortcut or window fails to open' },
  other: { id: 'other', anchor: '6-6-other-startup-problems', title: 'Other startup problems' },
  sound: { id: 'sound', anchor: '6-7-no-sound-or-low-volume', title: 'No sound or low volume' },
  dll: { id: 'dll', anchor: '6-8-store-build-startup-error-0xc0000135', title: 'Store build startup error 0xC0000135' },
  diagnose: { id: 'diagnose', anchor: '5-4-user-manual-and-automatic-troubleshooting', title: 'User manual and automatic troubleshooting' },
  settings: { id: 'settings', anchor: '3-6-settings-navigation', title: 'Settings navigation' },
  storage: { id: 'storage', anchor: '8-data-and-directories', title: 'Data and directories' },
  network: { id: 'network', anchor: '5-2-automatic-diagnostics-and-networking', title: 'Automatic diagnostics and networking' },
});

const ARM_RE = /NO_MATCHING_ABIS|DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|arm64-v8a|armeabi-v7a|ARM (?:translation|native bridge)/i;
const ADB_RE = /ADB_UNAUTHORIZED|unauthorized|allow USB debugging|debugging authorization/i;
const SOUND_RE = /audio|sound|volume|mute|Audiosrv/i;
const DLL_RE = /0x0?c0000135|3221225781|STATUS_DLL_NOT_FOUND|DLL failed to load|DLL load failure|dependency DLL|missing DLL|MSVCP140|VCRUNTIME|FaultingModuleName/i;

const ISSUE_MAP = Object.freeze({
  'accel.softwareEmulation': 'accel',
  'device.unauthorized': 'adb',
  'device.offline': 'adb',
  'device.missing': 'adb',
  'settings.orientationConflict': 'startup',
  'settings.detachedFullscreen': 'startup',
  'settings.snapshotOffLowDisk': 'storage',
  'storage.sharedBroken': 'storage',
  'settings.audioDisabled': 'sound',
  'audio.disabled': 'sound',
  'audio.windowsServiceStopped': 'sound',
  'storage.diskCritical': 'storage',
  'storage.diskLow': 'storage',
  'storage.dataNeedsReset': 'storage',
  'storage.dataMismatch': 'storage',
  'network.guestDown': 'network',
  'network.sourcesDown': 'network',
  'runtime.staleLocks': 'startup',
  'runtime.orphanProcesses': 'startup',
  'runtime.staleSnapshot': 'startup',
  'runtime.stuckBoot': 'startup',
  DLL: 'dll',
  vcRedist: 'dll',
});

function topicByText(text) {
  const s = String(text || '');
  if (ARM_RE.test(s)) return 'arm';
  if (ADB_RE.test(s)) return 'adb';
  if (SOUND_RE.test(s)) return 'sound';
  if (DLL_RE.test(s)) return 'dll';
  if (/INSTALL_FAILED|INSTALL_PARSE|signature|installation package|invalid APK/i.test(s)) return 'install';
  if (/hardware acceleration|WHPX|AEHD|hypervisor|accel/i.test(s)) return 'accel';
  if (/attach failed|emu:0|rotation|embedded window|failed to open|unresponsive|shortcut/i.test(s)) return 'startup';
  if (/disk|storage|shared folder|data partition/i.test(s)) return 'storage';
  if (/network|DNS|download source/i.test(s)) return 'network';
  return 'overview';
}

function topicForIssue(issue) {
  if (!issue) return TOPICS.overview;
  const code = String(issue.code || '');
  let id = ISSUE_MAP[code];
  if (!id || code === 'runtime.bootFailed' || code === 'logs.errors') {
    id = topicByText(`${issue.title || ''} ${issue.detail || ''}`);
    if (id === 'overview' && code === 'runtime.bootFailed') id = 'startup';
    if (id === 'overview' && code === 'logs.errors') id = 'other';
  }
  return TOPICS[id] || TOPICS.overview;
}

function topicForError(text) {
  const s = String(text || '');
  if (!s.trim()) return TOPICS.overview;
  if (ARM_RE.test(s)) return TOPICS.arm;
  if (ADB_RE.test(s)) return TOPICS.adb;
  if (SOUND_RE.test(s)) return TOPICS.sound;
  if (DLL_RE.test(s)) return TOPICS.dll;
  if (/INSTALL_|PARSE_FAILED|installation failed|signature|invalid APK/i.test(s)) return TOPICS.install;
  if (/attach failed|emu:0|device not found|rotation window/i.test(s)) return TOPICS.startup;
  return topicByText(s) === 'overview' ? TOPICS.install : TOPICS[topicByText(s)];
}

function resolve(payload) {
  const p = typeof payload === 'string' ? { error: payload } : (payload || {});
  let topic = TOPICS.overview;
  if (p.topic && TOPICS[p.topic]) topic = TOPICS[p.topic];
  else if (p.issue || p.code) {
    const issue = typeof p.issue === 'string'
      ? { code: p.issue, title: p.title, detail: p.detail }
      : (p.issue || { code: p.code, title: p.title, detail: p.detail });
    topic = topicForIssue(issue);
  } else if (p.error || p.message || p.text) topic = topicForError(p.error || p.message || p.text);
  return {
    id: topic.id,
    anchor: topic.anchor,
    title: topic.title,
    reason: String(p.reason || ''),
  };
}

module.exports = { TOPICS, ISSUE_MAP, topicForIssue, topicForError, topicByText, resolve };
