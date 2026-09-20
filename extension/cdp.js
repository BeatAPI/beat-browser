
//

//

//

const L2_IDLE_MS = 5000;
const PROTOCOL = '1.3';

// tabId -> { timer, ready }
const sessions = new Map();

const dialogs = new Map();   // tabId -> { type, message, at }

export class L2Unavailable extends Error {
  constructor(reason, code = 'NEEDS_L2') {
    super(reason);
    this.code = code;
  }
}

//

// "Only permissions specified in the manifest may be requested."
//

export async function isEnabled() {
  if (!chrome.debugger) return false;
  try {
    const { l2Disabled } = await chrome.storage.local.get('l2Disabled');
    return !l2Disabled;
  } catch {
    return true;
  }
}

// ---------- attach / detach ----------

async function ensureAttached(tabId) {
  const s = sessions.get(tabId);
  if (s?.ready) return touch(tabId);

  if (!(await isEnabled())) {
    throw new L2Unavailable(
      'This step needs High-fidelity mode (browser-level real input events), but it is turned off. '
      + 'Ask the user to open the BeatBrowser extension icon, switch High-fidelity mode on, then retry.');
  }

  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    const m = String(e?.message || e);
    
    
    if (/Another debugger is already attached/i.test(m)) {
      throw new L2Unavailable(
        'This tab is already held by another debugger (usually you have DevTools open). '
        + 'Close DevTools and retry, or keep using ordinary mode.', 'L2_BUSY');
    }
    if (/Cannot access|chrome:\/\//i.test(m)) {
      throw new L2Unavailable(`The browser protects this page and does not allow debugging (${m})`, 'L2_BUSY');
    }
    throw new L2Unavailable(`attach failed: ${m}`, 'L2_BUSY');
  }

  sessions.set(tabId, { ready: true, timer: null });

  
  //
  
  
  
  //
  
  
  //
  
  
  
  await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  
  
  await send(tabId, 'Page.enable').catch(() => {});
  touch(tabId);
}

function touch(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => detach(tabId), L2_IDLE_MS);
}

export async function detach(tabId) {
  const s = sessions.get(tabId);
  if (s?.timer) clearTimeout(s.timer);
  sessions.delete(tabId);
  dialogs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    
  }
}

export async function reapOrphans() {
  return reap((tabId) => !sessions.has(tabId));
}

export async function reapAll() {
  for (const [tabId] of sessions) {
    const s = sessions.get(tabId);
    if (s?.timer) clearTimeout(s.timer);
  }
  sessions.clear();
  dialogs.clear();
  return reap(() => true);
}

async function reap(pick) {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null && pick(t.tabId)) {
        await chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
      }
    }
  } catch {
    
  }
}

function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function withL2(tabId, fn) {
  await ensureAttached(tabId);
  try {
    return await fn((method, params) => send(tabId, method, params));
  } finally {
    touch(tabId);
  }
}

const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const maskOf = (mods = []) => mods.reduce((n, m) => n | (MOD[String(m).toLowerCase()] || 0), 0);

//

export async function click(tabId, x, y, { button = 'left', clickCount = 1, mods = [] } = {}) {
  const modifiers = maskOf(mods);
  return withL2(tabId, async (cmd) => {
    const base = { x, y, button, modifiers };
    await cmd('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
    await cmd('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1, clickCount });
    await cmd('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0, clickCount });
    return true;
  });
}

export async function hover(tabId, x, y) {
  return withL2(tabId, (cmd) =>
    cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }));
}

export async function drag(tabId, x1, y1, x2, y2, { steps = 8 } = {}) {
  return withL2(tabId, async (cmd) => {
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none', buttons: 0 });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = x1 + (x2 - x1) * i / steps, y = y1 + (y2 - y1) * i / steps;
      await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
    return true;
  });
}

const VK = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};

export async function key(tabId, spec, { mods = [], repeat = 1 } = {}) {
  const parts = String(spec).split('+');
  const k = parts.pop() || '+';
  const allMods = [...parts, ...mods];
  const modifiers = maskOf(allMods);
  const vk = VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  const printable = k.length === 1 && !modifiers;

  return withL2(tabId, async (cmd) => {
    for (let i = 0; i < Math.min(Math.max(repeat, 1), 50); i++) {
      const base = {
        modifiers,
        key: k,
        code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      };
      
      await cmd('Input.dispatchKeyEvent', {
        ...base,
        type: printable ? 'keyDown' : 'rawKeyDown',
        ...(printable ? { text: k, unmodifiedText: k } : {}),
      });
      await cmd('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }
    return true;
  });
}

export async function insertText(tabId, text) {
  return withL2(tabId, (cmd) => cmd('Input.insertText', { text }));
}

// ---------- DOM ----------

export async function setFileInput(tabId, selector, files) {
  return withL2(tabId, async (cmd) => {
    const { root } = await cmd('DOM.getDocument', { depth: 1 });
    const { nodeId } = await cmd('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new L2Unavailable(`No element on the page matches ${selector}`, 'REF_NOT_FOUND');
    await cmd('DOM.setFileInputFiles', { nodeId, files });
    return true;
  });
}

//

export async function screenshot(tabId, { full = false } = {}) {
  return withL2(tabId, async (cmd) => {
    if (full) {
      const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return { dataUrl: `data:image/png;base64,${r.data}`, scale: 1 };
    }
    const scale = 0.6;
    const m = await cmd('Page.getLayoutMetrics');
    const v = m.cssVisualViewport || m.visualViewport || {};
    const width = Math.max(1, Math.round(v.clientWidth || 1280)), height = Math.max(1, Math.round(v.clientHeight || 800));
    const r = await cmd('Page.captureScreenshot', {
      format: 'jpeg', quality: 80, captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height, scale },
    });
    return { dataUrl: `data:image/jpeg;base64,${r.data}`, scale };
  });
}

export async function evaluate(tabId, expression, { maxLength = 20000 } = {}) {
  return withL2(tabId, async (cmd) => {
    const r = await cmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,   
    });
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new L2Unavailable(`Expression failed: ${msg}`, 'INTERNAL');
    }
    let s;
    try { s = JSON.stringify(r.result?.value, null, 2); } catch { s = String(r.result?.value); }
    if (s === undefined) s = 'undefined';
    return s.length > maxLength ? s.slice(0, maxLength) + '\n… (truncated)' : s;
  });
}

//

//

function wireDebuggerEvents() {
  if (!chrome.debugger?.onEvent || wireDebuggerEvents.done) return;
  wireDebuggerEvents.done = true;

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId == null) return;
    if (method === 'Page.javascriptDialogOpening') {
      dialogs.set(tabId, { type: params.type, message: params.message, at: Date.now() });
    } else if (method === 'Page.javascriptDialogClosed') {
      dialogs.delete(tabId);
    }
  });

  
  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source.tabId;
    if (tabId == null) return;
    const s = sessions.get(tabId);
    if (s?.timer) clearTimeout(s.timer);
    sessions.delete(tabId);
    dialogs.delete(tabId);
  });
}

wireDebuggerEvents();
chrome.permissions?.onAdded?.addListener(wireDebuggerEvents);

export const pendingDialog = (tabId) => dialogs.get(tabId) || null;

export async function handleDialog(tabId, { accept = false, promptText } = {}) {
  const d = dialogs.get(tabId);
  if (!d) return null;
  await withL2(tabId, (cmd) =>
    cmd('Page.handleJavaScriptDialog', { accept, ...(promptText ? { promptText } : {}) }));
  dialogs.delete(tabId);
  return d;
}

export const isAttached = (tabId) => !!sessions.get(tabId)?.ready;
