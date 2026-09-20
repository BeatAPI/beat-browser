const dot = document.getElementById('dot');
const state = document.getElementById('state');
const btn = document.getElementById('btn');
const conntip = document.getElementById('conntip');

document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;

function render(connected, r = {}) {
  dot.classList.toggle('on', connected);
  state.textContent = connected ? 'Connected' : 'Not connected';
  btn.hidden = connected;
  btn.disabled = false;
  btn.textContent = 'Reconnect';

  const age = r.lastRx ? Math.round((Date.now() - r.lastRx) / 1000) : null;
  const bits = [];
  if (r.bridge) {
    const mismatch =
      r.bridge !== chrome.runtime.getManifest().version
        ? ' (reload extension)'
        : '';
    bits.push('bridge ' + r.bridge + mismatch);
  }
  if (connected && age !== null) bits.push(age + 's');
  if (!connected && r.offscreenError) bits.push(String(r.offscreenError));
  conntip.textContent = bits.join(' · ');
  conntip.hidden = !bits.length;
}

chrome.runtime.sendMessage({ __hcPopup: 'status' }, (r) => render(!!r?.connected, r || {}));

btn.onclick = () => {
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  chrome.runtime.sendMessage({ __hcPopup: 'connect' }, (r) => render(!!r?.connected, r || {}));
};

const l2btn = document.getElementById('l2btn');
const l2state = document.getElementById('l2state');

function renderL2(on) {
  l2btn.classList.toggle('on', on);
  l2btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  l2state.textContent = on ? 'High-fidelity input' : 'High-fidelity input';
}

chrome.storage.local.get('l2Disabled', ({ l2Disabled }) => renderL2(!l2Disabled));

const markbtn = document.getElementById('markbtn');
const markstate = document.getElementById('markstate');
const sess = document.getElementById('sess');

function renderMark(on) {
  markbtn.classList.toggle('on', on);
  markbtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  markstate.textContent = 'Show control marks';
}

function renderSessions(rows) {
  sess.textContent = '';
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = 's';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = r.color;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = r.label;
    const page = document.createElement('span');
    page.className = 'page';
    page.textContent = r.title ? '· ' + r.title : '· idle';
    line.append(sw, who, page);
    sess.appendChild(line);
  }
}

function refreshMark() {
  chrome.runtime.sendMessage({ __hcPopup: 'sessions' }, (r) => {
    renderMark(r?.enabled !== false);
    renderSessions(r?.sessions || []);
  });
}
refreshMark();

markbtn.onclick = () => {
  chrome.storage.local.get('markDisabled', ({ markDisabled }) => {
    chrome.storage.local.set({ markDisabled: !markDisabled }, () => {
      chrome.runtime.sendMessage({ __hcPopup: 'markSync' }, () => refreshMark());
    });
  });
};

l2btn.onclick = () => {
  chrome.storage.local.get('l2Disabled', ({ l2Disabled }) => {
    const turningOff = !l2Disabled;
    if (turningOff) {
      chrome.runtime.sendMessage({ __hcPopup: 'detachAll' }, () => {
        chrome.storage.local.set({ l2Disabled: true }, () => renderL2(false));
      });
    } else {
      chrome.storage.local.set({ l2Disabled: false }, () => renderL2(true));
    }
  });
};
