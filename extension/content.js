
//

//

(() => {
  if (window.__beatBrowser) return;
  window.__beatBrowser = true;

  let refMap = new Map();
  let snapshotSeq = 0;
  let snapshotId = null;
  
  
  let lastTarget = null;

  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'combobox', 'textbox', 'switch', 'option', 'searchbox']);

  

  
  
  
  function isVisible(el, s = getComputedStyle(el), anywhere = false) {
    if (!el.isConnected) return false;
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.02) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    
    if (!anywhere && offWindow(r)) return false;
    return true;
  }
  const offWindow = (r) => r.bottom < -window.innerHeight * 2 || r.top > window.innerHeight * 3;

  
  
  
  
  function isInteractive(el, s) {
    if (INTERACTIVE_TAGS.has(el.tagName)) {
      if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
      if (el.tagName === 'A' && !el.getAttribute('href')) return false;
      return true;
    }
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
    
    
    
    if (s.cursor === 'pointer' && (el.innerText || '').trim()) return true;
    return false;
  }

  

  function accessibleName(el) {
    const byId = (ids) => (ids || '').split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' ').trim();
    const cands = [
      el.getAttribute('aria-label'),
      byId(el.getAttribute('aria-labelledby')),
      el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText : '',
      el.closest('label')?.innerText,
      el.getAttribute('placeholder'),
      
      
      el.getAttribute('data-placeholder'),
      el.getAttribute('aria-placeholder'),
      el.dataset?.placeholder,
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.querySelector('img[alt]')?.getAttribute('alt'),
      
      el.querySelector('svg > title')?.textContent,
      el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '',
      
      
      el.tagName === 'SELECT' ? '' : el.innerText,
      
      
      
      byId(el.getAttribute('aria-describedby')),
      el.getAttribute('name'),
    ];
    for (const c of cands) {
      const t = (c || '').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 60 ? t.slice(0, 60) + '…' : t;
    }
    return nearbyLabel(el);
  }

  
  //
  
  
  
  
  //
  
  const LABEL_SEL = 'label, legend, .form-label, [class*="label" i], [id$="-label"]';

  function nearbyLabel(el) {
    
    
    const isControl = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
      || el.isContentEditable
      || ['combobox', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch'].includes(el.getAttribute('role'));
    if (!isControl) return '';

    let node = el.parentElement;
    
    
    for (let up = 0; node && up < 7; up++, node = node.parentElement) {
      if (node.tagName === 'FORM' || node.tagName === 'BODY') break;
      for (const cand of node.querySelectorAll(LABEL_SEL)) {
        if (cand.contains(el)) continue;                       
        if (cand.htmlFor && cand.htmlFor !== el.id) continue;   
        const t = (cand.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 40) return t;
      }
    }
    return '';
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    switch (el.tagName) {
      case 'A': return 'link';
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'SELECT': return 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT': {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'search') return 'searchbox';
        
        
        
        if (t === 'file') return 'file';
        return 'textbox';
      }
      default: return el.isContentEditable ? 'textbox' : 'button';
    }
  }

  
  
  
  
  const STATE_CLASS = /(?:^|[-_])(checked|selected|active|open|current|pressed|on|off|expanded|collapsed)$/i;
  function stateClass(el) {
    const cls = String(el.className?.baseVal ?? el.className ?? '');
    for (const t of cls.split(/\s+/)) if (t && STATE_CLASS.test(t)) return t;
    return '';
  }

  
  
  
  function idHint(el) {
    const id = el.id || '';
    if (id && id.length <= 40 && !/^[a-z0-9_-]{24,}$/i.test(id)) return `#${id}`;
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
    if (tid) return `[data-testid="${tid.slice(0, 40)}"]`;
    const cls = String(el.className?.baseVal ?? el.className ?? '').trim().split(/\s+/)[0] || '';
    if (cls && cls.length <= 40) return `.${cls}`;
    return '';
  }

  const isDisabled = (el) => !!(el.disabled || el.matches?.(':disabled') || el.getAttribute('aria-disabled') === 'true');

  
  function stateOf(el, role) {
    const bits = [];
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
      const checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
      bits.push(checked ? 'checked' : 'unchecked');
    }
    if (role === 'file') {
      const f = el.files?.[0];
      bits.push(f ? `selected ${f.name}` : 'empty');
      if (el.accept) bits.push(`accept: ${el.accept}`);
      bits.push('use the upload tool; type does not work');
    }
    if (role === 'textbox' || role === 'searchbox') {
      const v = (el.value ?? el.innerText ?? '').trim();
      
      
      const t = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : '';
      if (t && t !== 'text') bits.push(`type: ${t}`);
      if (el.required || el.getAttribute('aria-required') === 'true') bits.push('required');
      
      
      
      if (!v) bits.push('empty');
      else if (isSecretField(el)) bits.push(`value: <${v.length} chars>`);
      else {
        
        const cap = el.isContentEditable ? 200 : 40;
        bits.push(`value: "${v.length > cap ? v.slice(0, cap) + '…' : v}"`);
      }
    }
    if (role === 'combobox' && el.tagName === 'SELECT') {
      bits.push(`selected: "${el.options[el.selectedIndex]?.text || ''}"`);
      const opts = [...el.options].slice(0, 8).map((o) => o.text).join(' | ');
      if (opts) bits.push(`options: ${opts}${el.options.length > 8 ? ' …' : ''}`);
    }
    if (el.getAttribute('aria-expanded')) bits.push(`expanded: ${el.getAttribute('aria-expanded')}`);
    
    
    for (const a of ['aria-selected', 'aria-pressed', 'aria-current']) {
      const v = el.getAttribute(a);
      if (v && v !== 'false') bits.push(`${a.slice(5)}${v === 'true' ? '' : ': ' + v}`);
    }
    const sc = stateClass(el);
    if (sc) bits.push(`class: ${sc}`);
    if (isDisabled(el)) bits.push('disabled');
    return bits.length ? ` (${bits.join(', ')})` : '';
  }

  

  
  
  
  function collectCandidates() {
    
    const cands = [];
    
    
    let off = 0;
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        const s = getComputedStyle(el);
        if (!isInteractive(el, s)) continue;
        if (!isVisible(el, s)) {
          if (isVisible(el, s, true)) off += 1;
          continue;
        }
        const semantic = INTERACTIVE_TAGS.has(el.tagName)
          || INTERACTIVE_ROLES.has(el.getAttribute('role'))
          || el.isContentEditable;
        cands.push({
          el,
          semantic,
          
          
          
          weak: !semantic && !el.hasAttribute('onclick')
            && el.getAttribute('tabindex') === null && !el.getAttribute('role'),
        });
        if (cands.length >= 400) { cands.truncated = true; return; } 
      }
    };
    walk(document);

    
    
    const has = (pred) => cands.some(pred);
    const keep = cands.filter(({ el, semantic, weak }) => {
      
      
      if (el.tagName === 'LABEL') {
        const target = el.htmlFor ? document.getElementById(el.htmlFor) : el.querySelector('input,select,textarea');
        if (target && has((o) => o.el === target)) return false;
      }
      if (semantic) return true;
      
      if (weak && has((o) => o.el !== el && o.el.contains(el))) return false;
      
      
      
      if (has((o) => o.el !== el && el.contains(o.el))) return false;
      return true;
    });
    keep.truncated = !!cands.truncated;
    keep.offWindow = off;
    return keep;
  }

  function buildSnapshot() {
    
    //
    
    
    
    
    //
    
    
    
    const prevRef = new Map();
    for (const [r, rec] of refMap) {
      if (rec.el?.isConnected) prevRef.set(rec.el, r);
    }

    refMap = new Map();
    snapshotId = 's' + ++snapshotSeq;
    const keep = collectCandidates();

    
    
    const rows = [];
    const taken = new Set();
    let unnamed = 0, truncated = keep.truncated;
    for (const { el } of keep) {
      const role = roleOf(el);
      const name = accessibleName(el);
      let hint = '';
      if (!name && role === 'button') {
        
        
        
        
        
        hint = idHint(el);
        if (!hint || unnamed >= 40) { if (hint) truncated = true; continue; }
        unnamed += 1;
      }
      const ref = prevRef.get(el) || null;
      if (ref) taken.add(ref);
      rows.push({ el, role, name, ref, hint });
      if (rows.length >= 300) { truncated = true; break; }
    }
    let next = 0;
    for (const row of rows) {
      if (row.ref) continue;
      do { next += 1; } while (taken.has('e' + next));
      row.ref = 'e' + next;
      taken.add(row.ref);
    }

    const lines = [];
    let n = 0;
    for (const { el, role, name, ref, hint } of rows) {
      n += 1;
      
      
      
      
      refMap.set(ref, { el, role, name });
      const st = stateOf(el, role);
      const tail = hint ? (st ? st.replace(/\)$/, `, ${hint})`) : ` (${hint})`) : st;
      lines.push(`[${ref}]  ${role.padEnd(9)} "${name}"${tail}`);
    }

    const excerpt = mainText().slice(0, 1500);
    const alerts = collectAlerts();
    const overlays = collectOverlays();
    const tools = collectDeclaredTools(refMap);
    const header = `# ${document.title} — ${location.href}\n[snapshot ${snapshotId}] ${n} interactive elements`
      + (truncated ? ' (truncated: too many elements, only some are listed; scroll to what you need and snapshot again)' : '')
      + (keep.offWindow ? ` (${keep.offWindow} more beyond a few screens above/below the viewport; scroll there and snapshot again to see them)` : '') + '\n'
      + (alerts.length ? `\n⚠️ Page alerts:\n${alerts.map((a) => '  · ' + a).join('\n')}\n` : '')
      + (overlays.length ? `\n🪟 Overlays/dialogs (covering the page, usually handle these first):\n${overlays.map((a) => '  · ' + a).join('\n')}\n` : '')
      + (tools.length ? `\n🔧 Tools declared by the page (WebMCP forms; the site's own parameter docs, more reliable than guessing fields):\n${tools.map((a) => '  · ' + a).join('\n')}\n` : '');
    return {
      untrusted: true,
      meta: `url="${location.href}" snapshot="${snapshotId}"`,
      snapshotId,
      alerts,
      text: `${header}\n${lines.join('\n')}\n\n--- Text excerpt (use read_text for the full text) ---\n${excerpt}${excerpt.length >= 1500 ? '…' : ''}`,
    };
  }

  
  
  
  //
  
  const ALERT_SEL = [
    '[role="alert"]', '[role="alertdialog"]', '[aria-live="assertive"]', '[aria-live="polite"]',
    '[aria-invalid="true"]', '.error', '.errors', '.alert', '.flash', '.toast', '.message--error',
    '[class*="error" i]', '[class*="invalid" i]', '[class*="warning" i]', '[class*="toast" i]',
  ].join(',');

  
  
  
  //
  
  
  function challengeEvidence() {
    const frames = [], overlays = [];
    try {
      for (const f of document.querySelectorAll('iframe[src]')) {
        if (frames.length >= 8) break;
        if (isVisible(f)) frames.push(f.src);
      }
      const tops = new Set([
        ...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]'),
        ...Array.from(document.body?.children || []).filter((e) => {
          const cs = getComputedStyle(e);
          return cs.position === 'fixed' && cs.display !== 'none' && +cs.zIndex >= 100;
        }),
      ]);
      for (const el of tops) {
        if (overlays.length >= 5) break;
        if (!isVisible(el)) continue;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t) overlays.push(t.slice(0, 300));
      }
    } catch {  }
    return { frames, overlays };
  }

  
  
  
  
  
  const OVERLAY_CLASS = /modal|dialog|popup|drawer|overlay|mask|lightbox/i;
  function collectOverlays() {
    const out = [];
    try {
      const tops = new Set([
        ...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]'),
        ...Array.from(document.body?.children || []).filter((e) => {
          if (e.shadowRoot || !OVERLAY_CLASS.test(String(e.className?.baseVal ?? e.className ?? ''))) return false;
          const cs = getComputedStyle(e);
          return cs.position === 'fixed' && cs.display !== 'none';
        }),
      ]);
      for (const el of tops) {
        if (out.length >= 4) break;
        if (!isVisible(el)) continue;
        
        if (el.querySelector('[role="dialog"],[role="alertdialog"]')) continue;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t.length > 200 ? t.slice(0, 200) + '…' : t);
      }
    } catch {  }
    return out;
  }

  
  // <form toolname tooldescription> + <input name toolparamdescription>
  
  
  
  
  function collectDeclaredTools(refs) {
    const out = [];
    try {
      for (const form of document.querySelectorAll('form[toolname]')) {
        if (out.length >= 6) break;
        const name = form.getAttribute('toolname') || '';
        const desc = (form.getAttribute('tooldescription') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const params = [];
        for (const el of form.querySelectorAll('[name]')) {
          if (params.length >= 8) break;
          const pd = (el.getAttribute('toolparamdescription') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          let ref = '';
          for (const [r, rec] of refs) if (rec.el === el) { ref = r; break; }
          params.push(`${el.getAttribute('name')}${pd ? ` (${pd})` : ''}${ref ? ` [${ref}]` : ''}`);
        }
        out.push(`${name}${desc ? ` — ${desc}` : ''}${params.length ? `; params: ${params.join(', ')}` : ''}`
          + (form.hasAttribute('toolautosubmit') ? '; the site allows auto-submit' : ''));
      }
    } catch {  }
    return out;
  }

  function collectAlerts() {
    const out = new Set();
    let nodes;
    try { nodes = document.querySelectorAll(ALERT_SEL); } catch { return []; }
    for (const el of nodes) {
      if (out.size >= 6) break;
      
      
      if (el.querySelector(ALERT_SEL)) continue;
      if (!isVisible(el)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 200) continue;

      
      
      
      
      const declared = el.matches('[role="alert"],[role="alertdialog"],[aria-live],[aria-invalid="true"]');
      if (!declared) {
        if (el.closest('nav,header,footer,aside')) continue;
        
        const a = el.querySelector('a');
        if (el.tagName === 'A' || (a && (a.innerText || '').trim() === t)) continue;
      }
      out.add(t);
    }
    return [...out];
  }

  

  function mainText() {
    const cand = document.querySelector('article, main, [role="main"], #js_content, .article-content, .post-content') || document.body;
    const clone = cand.cloneNode(true);
    
    
    
    clone.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, iframe, [aria-hidden="true"]').forEach((n) => n.remove());
    return (clone.innerText || '')
      .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function toMarkdown() {
    const cand = document.querySelector('article, main, [role="main"], #js_content') || document.body;
    const clone = cand.cloneNode(true);
    clone.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, iframe, [aria-hidden="true"]').forEach((n) => n.remove());
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        const tag = c.tagName.toLowerCase();
        
      
      
      const t = clean(c.innerText || '');
        if (/^h[1-6]$/.test(tag) && t) out.push('#'.repeat(+tag[1]) + ' ' + t);
        else if (tag === 'p' && t) out.push(t);
        else if (tag === 'blockquote' && t) out.push('> ' + t);
        else if (tag === 'pre') out.push('```\n' + c.innerText.trim() + '\n```');
        else if (tag === 'li' && t) out.push('- ' + t);
        
        
        else if (tag === 'img') {
          const real = c.getAttribute('data-src') || c.getAttribute('data-original') || c.getAttribute('data-actualsrc') || c.src;
          
          
          
          const small = (c.naturalWidth && c.naturalWidth < 80) || c.clientWidth < 60;
          if (real && !real.startsWith('data:') && !small) out.push(`![${c.alt || ''}](${real})`);
        }
        else if (c.children.length) walk(c);
        else if (t) out.push(t);
      }
    };
    walk(clone);
    return out.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');
  }

  
  const clean = (s2) => s2.replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, '').replace(/\s+/g, ' ').trim();

  

  
  //
  
  
  //
  
  
  

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function findEl(spec) {
    if (spec.selector) {
      const el = document.querySelector(spec.selector);
      if (!el) throw fail('REF_NOT_FOUND', `Selector matched no element: ${spec.selector}`);
      return el;
    }

    const pool = collectCandidates()
      .map(({ el }) => el)
      .filter((el) => !spec.role || roleOf(el) === spec.role);

    const want = norm(spec.name);
    if (!want) {
      if (pool.length === 1) return pool[0];
      throw fail('REF_NOT_FOUND',
        `Only role="${spec.role}" was given, and the page has ${pool.length} of them. Add a name.`);
    }

    
    
    
    const named = pool.map((el) => ({ el, name: norm(accessibleName(el)) }));
    const bare = (s) => s.replace(/\s/g, '');
    const tiers = [
      named.filter((x) => x.name === want),
      named.filter((x) => bare(x.name) === bare(want)),
      
      named.filter((x) => x.name && (x.name.includes(want) || want.includes(x.name.replace(/…$/, '')))),
    ];
    const hit = tiers.find((t) => t.length);

    if (!hit) {
      const sample = named.filter((x) => x.name).slice(0, 12).map((x) => `"${x.name}"`).join(', ');
      throw fail('REF_NOT_FOUND',
        `Could not find${spec.role ? ` a role=${spec.role}` : ''} "${spec.name}". ` +
        + `Found on the page: ${sample || '(no interactive elements with a name)'}`);
    }
    
    
    if (hit.length > 1 && spec.nth === undefined) {
      throw fail('REF_NOT_FOUND',
        `"${spec.name}" matched ${hit.length} elements, not guessing. Pick one with nth (0-based), ` 
        + `or write a fuller name. Candidates: ${hit.slice(0, 8).map((x) => `"${x.name}"`).join(', ')}`);
    }
    const picked = hit[spec.nth || 0];
    if (!picked) {
      throw fail('REF_NOT_FOUND', `nth=${spec.nth} is out of range; "${spec.name}" matched only ${hit.length}`);
    }
    return picked.el;
  }

  function resolve(p) {
    
    
    if (p.find) return findEl(p.find);
    
    
    
    
    
    if (p.selector && p.ref) {
      throw fail('INTERNAL',
        'Give either ref or selector, not both. If both are sent only selector takes effect while the receipt shows the ref, '
        + 'so a wrong click cannot be seen from the result. Use only ref for a snapshot id, or only selector for a CSS selector.');
    }
    
    
    
    if (p.selector) {
      const el = document.querySelector(p.selector);
      if (!el) throw fail('REF_NOT_FOUND', `Selector matched no element: ${p.selector}`);
      return el;
    }
    if (!snapshotId) throw fail('STALE_SNAPSHOT', 'This page has no snapshot yet; call snapshot first');
    if (p.snapshotId && p.snapshotId !== snapshotId) {
      throw fail('STALE_SNAPSHOT', `Snapshot ${p.snapshotId} is void (current ${snapshotId}). Take a new snapshot and retry.`);
    }
    const rec = refMap.get(p.ref);
    if (!rec) throw fail('REF_NOT_FOUND', `${p.ref} is not in the snapshot`);
    const el = rec.el;
    if (!el.isConnected) throw fail('REF_NOT_FOUND', `${p.ref} was removed from the page; take a new snapshot`);
    
    
    
    
    const now = accessibleName(el);
    if (rec.name && now !== rec.name) {
      throw fail('STALE_SNAPSHOT',
        `${p.ref} is now "${now}", no longer the "${rec.name}" you saw. ` +
        + 'That part of the page was replaced. Take a new snapshot and retry.');
    }
    if (!isVisible(el)) throw fail('NOT_INTERACTABLE', `${p.ref} is not visible right now`);
    if (isDisabled(el)) throw fail('NOT_INTERACTABLE', `${p.ref} is disabled, usually because the form is incomplete or validation failed; check the page alerts in the snapshot`);
    return el;
  }

  const fail = (code, message) => Object.assign(new Error(message), { code });

  
  //   pointerover → mouseover → mousemove → pointerdown → mousedown → focus
  //   → pointerup → mouseup → click
  
  //
  
  
  
  
  //
  
  
  
  //
  
  
  
  
  const describeHit = (el) => {
    try {
      const name = accessibleName(el);
      return `${roleOf(el)}${name ? ` "${name.slice(0, 40)}"` : ''}`;
    } catch {
      return '';
    }
  };

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

    
    
    
    const inner = document.elementFromPoint(x, y);
    if (inner && el.contains(inner)) el = inner;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };

    const fire = (Ctor, type, extra) => el.dispatchEvent(new Ctor(type, { ...extra }));
    try {
      fire(PointerEvent, 'pointerover', ptr);
      fire(MouseEvent, 'mouseover', base);
      fire(MouseEvent, 'mousemove', base);
      fire(PointerEvent, 'pointerdown', { ...ptr, buttons: 1 });
      
      
      
      
      const notPrevented = el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      if (notPrevented) el.focus?.();
      fire(PointerEvent, 'pointerup', ptr);
      fire(MouseEvent, 'mouseup', base);
    } catch {
      
    }
    
    
    
    //
    
    
    
    fire(MouseEvent, 'click', base);
  }

  
  //
  
  
  //
  
  
  
  
  

  
  
  
  const EDITOR_HOSTS = '.monaco-editor,.CodeMirror,.cm-editor,[data-slate-editor],.ql-editor,.ProseMirror';

  
  
  const SENSITIVE_TEXT = /submit|pay|checkout|delete|publish|confirm|purchase/i;

  function preferOf(el) {
    
    
    
    
    if (el.tagName === 'SELECT') return 'L1';
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file') return 'L2';
    if (el.closest?.(EDITOR_HOSTS)) return 'L2';
    return null;
  }

  function isSensitive(el) {
    const name = [el.innerText, el.value, el.getAttribute?.('aria-label'), el.getAttribute?.('title')]
      .map((s) => (s || '').trim()).find(Boolean) || '';
    if (SENSITIVE_TEXT.test(name.slice(0, 40))) return true;
    
    
    
    
    if (/^(BUTTON|INPUT)$/.test(el.tagName)
      && /^(submit|image)$/i.test(el.type || '')
      && el.closest('form')) return true;
    const cls = `${el.className?.baseVal ?? el.className ?? ''} ${el.getAttribute?.('data-testid') || ''}`;
    return /\b(pay|submit|checkout|delete|remove|confirm|publish)\b/i.test(cls);
  }

  
  //
  
  
  
  
  const PAY_TEXT = /pay\s?now|checkout|place\s?order|buy\s?now|purchase|add\s?to\s?cart|order\s?now/i;

  
  
  
  const MONEY = /[¥$€£]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:USD|CNY|RMB)/i;
  const GENERIC_OK = /^(ok|confirm|submit|continue|next|agree|yes)$/i;

  const labelOf = (el) => [el.innerText, el.value, el.getAttribute?.('aria-label'), el.getAttribute?.('title')]
    .map((s) => (s || '').trim()).find(Boolean) || '';

  
  //
  
  
  
  
  //
  
  
  
  
  function moneyNear(el) {
    let box = el;
    for (let up = 0; box && up < 2; up++, box = box.parentElement) {
      const m = MONEY.exec((box.innerText || '').trim());
      if (m) return m[0].trim();
    }
    return '';
  }

  
  //
  
  
  
  
  //
  
  
  
  //
  
  
  
  //
  
  
  
  let payGuard = null;
  let payBlocked = null;

  function armPayGuard() {
    if (payGuard) return;
    payBlocked = null;
    payGuard = (e) => {
      if (e.isTrusted) return;                     
      const el = e.target?.closest?.('button,a,[role="button"],input,[onclick]');
      if (!el) return;
      const pay = payInfo(el);
      if (!pay) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      payBlocked = pay;
    };
    document.addEventListener('click', payGuard, true);
  }

  function disarmPayGuard() {
    if (payGuard) document.removeEventListener('click', payGuard, true);
    payGuard = null;
    const was = payBlocked;
    payBlocked = null;
    return was;
  }

  
  
  function payInfo(el) {
    const label = labelOf(el).slice(0, 60);
    if (PAY_TEXT.test(label)) return { label, amount: moneyNear(el) };
    if (GENERIC_OK.test(label)) {
      const amount = moneyNear(el);
      if (amount) return { label, amount };
    }
    return null;
  }

  async function doLocate(p) {
    
    if (p.baselineOnly) {
      lastTarget = null;
      
      const refs = Array.isArray(p.fields) ? p.fields.map((f) => f.ref).filter(Boolean) : [];
      return { baseline: await baselineOf(null, refs) };
    }
    const el = resolve(p);
    lastTarget = el;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

    
    
    
    
    
    window.__hcCursor?.(x, y, ({ click: 'click', type: 'type', select: 'type', key: 'key' })[p.forCmd] || 'aim');

    
    
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      throw fail('NOT_INTERACTABLE', `${p.ref || p.selector} is covered by another element (maybe a dialog or overlay). Deal with the covering element first.`);
    }
    
    
    const outside = x < 0 || y < 0 || x > innerWidth || y > innerHeight;

    
    
    const baseline = await baselineOf(el);
    return {
      x, y, outside,
      tag: el.tagName,
      role: roleOf(el),
      prefer: preferOf(el),
      sensitive: isSensitive(el),
      pay: payInfo(el),
      baseline,
    };
  }

  
  //
  
  
  
  
  //
  
  

  const activeDesc = () => {
    const a = document.activeElement;
    return a && a !== document.body ? `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}${a.name ? `[name=${a.name}]` : ''}` : '';
  };

  
  //
  
  
  
  
  //
  
  const SECRET_FIELD = /pass|pwd|secret|token|cvv|captcha|verif|code|otp/i;
  const isSecretField = (el) => {
    if ((el.type || '').toLowerCase() === 'password') return true;
    try {
      return SECRET_FIELD.test(`${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`);
    } catch {
      return false;
    }
  };

  function targetState(el) {
    if (!el || !el.isConnected) return { gone: true };
    const raw = String(el.value ?? '');
    return {
      expanded: el.getAttribute('aria-expanded') ?? '',
      checked: String(el.checked ?? el.getAttribute('aria-checked') ?? ''),
      selected: el.getAttribute('aria-selected') ?? '',
      value: isSecretField(el) ? (raw ? `<${raw.length} chars>` : '') : raw.slice(0, 120),
      cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 200),
    };
  }

  
  const cheapStats = () => ({
    els: document.getElementsByTagName('*').length,
    active: activeDesc(),
    bodyKids: document.body?.children.length ?? 0,
  });

  
  //
  
  
  
  
  
  //
  
  
  
  const renderedLen = (node) => (node?.innerText || '').length;

  
  //
  
  
  
  //
  
  
  
  const SCOPE_SEL = 'section,form,[role=dialog],[role=listbox],[role=menu],main,article,'
    + '[class*="modal" i],[class*="dialog" i],[class*="popover" i],[class*="dropdown" i]';

  
  //
  
  
  
  //
  
  
  function scopeBoxOf(el) {
    if (!el || !el.isConnected) return null;
    return el.closest(SCOPE_SEL) || document.body;
  }

  
  //
  
  
  
  //
  
  
  async function baselineOf(el, fieldRefs = []) {
    const s1 = cheapStats();
    await sleep(60);
    const s2 = cheapStats();
    const volatile = Math.abs(s2.els - s1.els) >= 3;
    const box = scopeBoxOf(el);
    return {
      ...s2,
      volatile,
      textLen: renderedLen(document.body),
      scope: box ? { kids: box.getElementsByTagName('*').length, len: renderedLen(box) } : null,
      alerts: collectAlerts(),
      target: targetState(el),
      
      //
      
      
      
      
      fields: fieldRefs.map((r) => {
        const rec = refMap.get(r);
        return rec ? { ref: r, ...targetState(rec.el) } : null;
      }).filter(Boolean),
    };
  }

  function doEffect(p) {
    const base = p.baseline || {};
    
    
    
    
    //
    
    
    
    
    //
    
    
    
    let el = null;
    try {
      el = p.ref ? refMap.get(p.ref)?.el
        : p.selector ? document.querySelector(p.selector)
        : lastTarget;
    } catch {
      
    }
    const now = cheapStats();

    
    
    
    
    const strong = [], weak = [];
    const parts = weak;

    
    
    

    
    
    const bt = base.target || {}, nt = targetState(el);
    
    
    
    
    
    if (nt.gone && !bt.gone) strong.push('target element was removed from the page');
    else for (const k of ['expanded', 'checked', 'selected', 'value', 'cls']) {
      if (bt[k] === undefined || bt[k] === nt[k]) continue;
      if (k === 'cls') { strong.push('target class changed'); continue; }
      strong.push(`${k} ${bt[k] || 'empty'} → ${nt[k] || 'empty'}`);
    }

    
    
    for (const bf of (base.fields || [])) {
      const rec = refMap.get(bf.ref);
      if (!rec) continue;
      const nf = targetState(rec.el);
      if (nf.gone && !bf.gone) { strong.push(`${bf.ref} was removed from the page`); continue; }
      for (const k of ['value', 'checked', 'selected']) {
        if (bf[k] === undefined || bf[k] === nf[k]) continue;
        strong.push(`${bf.ref} ${k} ${bf[k] || 'empty'} → ${nf[k] || 'empty'}`);
      }
    }

    
    
    const fresh = collectAlerts().filter((a) => !(base.alerts || []).includes(a));
    if (fresh.length) strong.push(`⚠️ page alert: ${fresh.join(' / ')}`);

    
    
    const dBodyKids = now.bodyKids - (base.bodyKids ?? now.bodyKids);
    if (dBodyKids !== 0) {
      strong.push(dBodyKids > 0
        ? `${dBodyKids} new top-level element(s) on the page (probably a dialog, overlay or toast)`
        : `${-dBodyKids} top-level element(s) removed from the page (probably a whole block was replaced)`);
    }

    
    
    
    
    const bs = base.scope, box = scopeBoxOf(el);
    if (bs && box) {
      const dKids = box.getElementsByTagName('*').length - bs.kids;
      if (dKids !== 0) strong.push(`target block DOM ${dKids > 0 ? '+' : ''}${dKids} nodes`);
      
      
      else if (!strong.length || (strong.length === 1 && strong[0] === 'target class changed')) {
        const dLen = renderedLen(box) - bs.len;
        if (Math.abs(dLen) >= 2) strong.push(`target block text ${dLen > 0 ? '+' : ''}${dLen} chars`);
      }
    }

    
    
    
    const dEls = now.els - (base.els ?? now.els);
    if (Math.abs(dEls) >= 3) parts.push(`DOM ${dEls > 0 ? '+' : ''}${dEls} nodes`);

    
    
    //
    
    
    
    
    if (!strong.length && base.textLen !== undefined) {
      const dText = renderedLen(document.body) - base.textLen;
      if (Math.abs(dText) >= 4) parts.push(`body text ${dText > 0 ? '+' : ''}${dText} chars`);
    }

    
    
    
    //
    
    
    
    //
    
    
    const focusedSelf = el && document.activeElement === el;
    if (now.active !== base.active && !focusedSelf) parts.push(`focus → ${now.active || '(none)'}`);

    
    
    const changed = strong.length > 0;
    return {
      changed,
      parts: [...strong, ...weak],
      alerts: fresh,
      volatile: !!base.volatile,
      
      
      unattributable: !strong.length && weak.length > 0,
      
      
      
      challengeEv: challengeEvidence(),
    };
  }

  

  async function doClick(p) {
    const el = resolve(p);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      throw fail('NOT_INTERACTABLE', `${p.ref} is covered by another element (maybe a dialog or overlay). Deal with the covering element first.`);
    }
    realClick(el);
    const retry = await retryCombobox(el);
    invalidate();
    return { data: { note: `Clicked [${p.ref || p.selector}] ${describeHit(el)}${retry}` } };
  }

  
  
  
  //
  
  
  
  async function retryCombobox(el) {
    const root = el.closest('[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="true"]')
      || (el.getAttribute('aria-expanded') !== null ? el : null);
    if (!root) return '';
    const flag = root.querySelector('[aria-expanded]') || root;

    
    
    
    await sleep(250);
    if (flag.getAttribute('aria-expanded') !== 'false') return '';  

    
    
    
    const ARROW = '[class*="indicator" i],[class*="arrow" i],[class*="caret" i],[class*="toggle" i],svg';
    let target = null;
    let box = root;
    for (let up = 0; box && up < 4 && !target; up++, box = box.parentElement) {
      const hits = [...box.querySelectorAll(ARROW)].filter((a) =>
        !a.contains(el) && a !== el
        
        
        && !/separator|divider/i.test(a.className?.baseVal ?? a.className ?? ''));
      
      const a = hits[hits.length - 1];
      
      if (a) target = a.tagName === 'svg' && a.parentElement ? a.parentElement : a;
    }
    if (!target || target === el || target.contains(el)) return '';

    realClick(target);
    await sleep(250);
    return flag.getAttribute('aria-expanded') === 'true'
      ? '(the control itself did not react; clicking its dropdown arrow expanded it, which is common for react-select style components)'
      : '(clicked, but aria-expanded is still false: the component may not use that attribute; check the snapshot below for new options)';
  }

  function doType(p) {
    const el = resolve(p);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    applyText(el, p.text, p.clear !== false);
    if (p.submit) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      el.closest('form')?.requestSubmit?.();
    }
    invalidate();
    return { data: { note: `Typed into [${p.ref || p.selector}] ${describeHit(el)}${p.submit ? ' and pressed Enter' : ''}` } };
  }

  function doSelect(p) {
    const el = resolve(p);
    if (el.tagName !== 'SELECT') {
      throw fail('NOT_INTERACTABLE',
        `${p.ref} is not a native <select>. A custom dropdown (built from divs) needs real interaction: ` +
        `click to expand, snapshot to see the options, then click one; or click and use key ArrowDown/Enter.`);
    }
    applySelect(el, p.value);
    invalidate();
    return { data: { note: `Selected "${p.value}"` } };
  }

  
  //
  
  
  
  //
  
  //
  
  
  function doFill(p) {
    const fields = Array.isArray(p.fields) ? p.fields : [];
    if (!fields.length) throw fail('INTERNAL', 'fields must not be empty');
    if (fields.length > 60) throw fail('INTERNAL', `At most 60 fields per call, received ${fields.length}`);

    const done = [], failed = [];
    for (const f of fields) {
      const spec = { ...f, snapshotId: p.snapshotId };
      try {
        const el = resolve(spec);
        const label = f.ref || f.selector;
        
        
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        
        
        const fr = el.getBoundingClientRect();
        window.__hcCursor?.(fr.left + fr.width / 2, fr.top + fr.height / 2, 'type');

        if (f.check !== undefined) {
          const want = !!f.check;
          const now = el.checked ?? el.getAttribute('aria-checked') === 'true';
          if (now !== want) realClick(el);
          done.push(`${label}=${want ? 'checked' : 'unchecked'}`);
        } else if (el.tagName === 'SELECT') {
          applySelect(el, String(f.value ?? f.text));
          done.push(`${label}="${f.value ?? f.text}"`);
        } else {
          const text = String(f.text ?? f.value ?? '');
          applyText(el, text, f.clear !== false);
          done.push(`${label}=${receipt(el, text)}`);
        }
      } catch (e) {
        failed.push(`${f.ref || f.selector}: ${e.message}`);
      }
    }

    let submitted = '';
    if (p.submit && !failed.length) {
      
      const form = document.querySelector('form');
      const btn = p.submitRef
        ? resolve({ ref: p.submitRef, snapshotId: p.snapshotId })
        : document.querySelector('button[type=submit],input[type=submit]');
      if (btn) { btn.click(); submitted = ', submit clicked'; }
      else if (form) { form.requestSubmit?.(); submitted = ', form submitted'; }
      else submitted = ', but no submit button was found';
    } else if (p.submit && failed.length) {
      submitted = ', submit skipped because a field failed (not submitting a half-filled form for you)';
    }

    invalidate();
    return {
      data: {
        note: `Filled ${done.length}/${fields.length}: ${done.join(', ')}`
          + (failed.length ? `\nNot done (${failed.length}): ${failed.join('; ')}` : '')
          + submitted,
      },
    };
  }

  
  
  function applyText(el, text, clear) {
    
    
    if (!el.isContentEditable && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
      throw fail('NOT_INTERACTABLE',
        `Target is <${el.tagName.toLowerCase()}>${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}, not a text input, so text cannot be written. `
        + `The snapshot is probably stale (numbering changes after a re-render); take a new snapshot and get the ref again.`);
    }
    if (el.tagName === 'INPUT' && /^(file|checkbox|radio|submit|button|image|reset)$/i.test(el.type)) {
      throw fail('NOT_INTERACTABLE',
        el.type === 'file'
          ? 'This is a file input; writing a string does nothing (the browser forbids it). Use the upload tool.'
          : `This is a ${el.type} input and cannot take text. Use fill with check for checkboxes/radios, and click for buttons.`);
    }
    el.focus();
    if (el.isContentEditable) {
      if (clear) el.textContent = '';
      document.execCommand('insertText', false, text);
      return;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, clear ? text : (el.value || '') + text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applySelect(el, value) {
    const opt = [...el.options].find((o) => o.value === value || o.text.trim() === value);
    
    
    if (!opt) throw fail('NO_MATCH', `No such option: ${value}. Available: ${[...el.options].map((o) => o.text).join(' | ')}`);
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  
  //
  
  
  const SECRET_HINT = /pass|pwd|secret|token|cvv|captcha|verif|code|otp/i;

  function receipt(el, text) {
    const t = (el.type || '').toLowerCase();
    const name = `${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`;
    if (t === 'password' || SECRET_HINT.test(name)) return `<filled ${text.length} chars, content not echoed>`;
    return `"${text.length > 20 ? text.slice(0, 10) + '…' : text}"`;
  }

  
  //
  
  
  
  //
  
  
  
  //
  

  const KEYCODES = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };
  
  const keyCodeOf = (k) => KEYCODES[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);

  const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex],[contenteditable=""],[contenteditable="true"]';

  function focusables() {
    return [...document.querySelectorAll(FOCUSABLE)].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && isVisible(el));
  }

  const MOD_NAMES = new Set(['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'cmd', 'command']);

  
  
  function parseKey(spec, extraMods = []) {
    const parts = String(spec).split('+');
    const key = parts.pop();
    const mods = parts
      .map((m) => m.trim().toLowerCase())
      .filter((m) => MOD_NAMES.has(m))
      .map((m) => ({ control: 'ctrl', option: 'alt', cmd: 'meta', command: 'meta' }[m] || m));
    
    return { key: key || '+', mods: [...new Set([...mods, ...extraMods])] };
  }

  function doKey(p) {
    
    
    const specs = Array.isArray(p.key) ? p.key : [p.key];
    if (!specs.length || !specs[0]) throw fail('INTERNAL', 'key must not be empty');

    
    
    if (!p.ref && !p.selector && !p.find) window.__hcCursor?.(null, null, 'key');
    const target0 = (p.ref || p.selector) ? resolve(p) : null;
    target0?.focus?.();

    const notes = [];
    for (const spec of specs) {
      
      
      //
      
      
      const live = document.activeElement;
      const target = (target0 && (live === target0 || live === document.body || !live))
        ? target0
        : (live || document.body);
      notes.push(pressOne(parseKey(spec, (p.mods || []).map((m) => m.toLowerCase())), target, p));
    }
    invalidate();
    return { data: { note: notes.join('; ') } };
  }

  function pressOne({ key, mods }, target, p) {
    const init = {
      key, code: p.code || (key.length === 1 ? `Key${key.toUpperCase()}` : key),
      keyCode: keyCodeOf(key), which: keyCodeOf(key),
      ctrlKey: mods.includes('ctrl'), shiftKey: mods.includes('shift'),
      altKey: mods.includes('alt'), metaKey: mods.includes('meta'),
      bubbles: true, cancelable: true, composed: true,
    };

    const times = Math.min(Math.max(Number(p.repeat) || 1, 1), 50);
    let defaultPrevented = false;
    let acted = '';

    for (let i = 0; i < times; i++) {
      const down = new KeyboardEvent('keydown', init);
      const ok = target.dispatchEvent(down);
      defaultPrevented = !ok;
      
      if (ok && key.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', init));
      if (ok) acted = emulateDefault(target, key, mods) || acted;
      target.dispatchEvent(new KeyboardEvent('keyup', init));
    }

    const combo = [...mods, key].join('+') + (times > 1 ? ` ×${times}` : '');
    return defaultPrevented
      ? `${combo} (the page blocked the default action, so it handles this key itself)`
      : `${combo}${acted ? ` → ${acted}` : ''}`;
  }

  
  function emulateDefault(el, key, mods) {
    const editable = el.isContentEditable ||
      (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|file)$/i.test(el.type)) ||
      el.tagName === 'TEXTAREA';

    if (key === 'Tab') {
      const list = focusables();
      const at = list.indexOf(el);
      const next = list[(at + (mods.includes('shift') ? -1 : 1) + list.length) % (list.length || 1)];
      if (!next) return 'no focusable element on the page';
      next.focus();
      return `focus moved to ${describeEl(next)}`;
    }

    if (key === 'Enter') {
      if (/^(BUTTON|A|SUMMARY)$/.test(el.tagName) || el.getAttribute('role') === 'button') {
        el.click();
        return 'triggered a click';
      }
      const form = el.closest?.('form');
      if (form && el.tagName === 'INPUT') {
        form.requestSubmit?.();
        return 'submitted the form';
      }
      return '';
    }

    if (key === ' ' && (/^(BUTTON|SUMMARY)$/.test(el.tagName) ||
        (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) ||
        el.getAttribute('role') === 'button' || el.getAttribute('role') === 'checkbox')) {
      el.click();
      return 'triggered a click';
    }

    if (key === 'Escape') {
      
      const dlg = document.querySelector('dialog[open]');
      if (dlg) { dlg.close?.(); return 'closed the <dialog>'; }
      return '';
    }

    if (editable && (key === 'Backspace' || key === 'Delete')) {
      if (el.isContentEditable) {
        document.execCommand(key === 'Backspace' ? 'delete' : 'forwardDelete');
      } else {
        const v = el.value || '';
        const s = el.selectionStart ?? v.length, e = el.selectionEnd ?? v.length;
        const [from, to] = s !== e ? [s, e] : key === 'Backspace' ? [Math.max(0, s - 1), s] : [s, s + 1];
        setNativeValue(el, v.slice(0, from) + v.slice(to));
        el.setSelectionRange?.(from, from);
      }
      return 'deleted characters';
    }

    if (editable && mods.includes('ctrl') && key.toLowerCase() === 'a') {
      el.select?.();
      return 'selected all';
    }

    
    if (editable && key.length === 1 && !mods.includes('ctrl') && !mods.includes('meta')) {
      if (el.isContentEditable) document.execCommand('insertText', false, key);
      else {
        const v = el.value || '';
        const s = el.selectionStart ?? v.length, e = el.selectionEnd ?? v.length;
        setNativeValue(el, v.slice(0, s) + key + v.slice(e));
        el.setSelectionRange?.(s + 1, s + 1);
      }
      return 'inserted characters';
    }

    return '';
  }

  
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const describeEl = (el) =>
    `${el.tagName.toLowerCase()}${el.name ? `[name=${el.name}]` : ''}` +
    `${el.placeholder ? ` "${el.placeholder}"` : ''}`;

  
  //
  
  
  
  //
  
  
  
  
  //
  
  async function doReady(p) {
    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    const quiet = Math.max(Number(p.quiet) || 300, 50);
    
    
    const budget = Math.min(Math.max(Number(p.budget) || 1500, quiet), 1500);
    const quieted = await new Promise((resolve) => {
      let quietTimer = null;
      const hard = setTimeout(() => done(false), budget);
      const mo = new MutationObserver((records) => {
        
        //
        
        
        
        
        //
        
        let added = 0;
        for (const r of records) added += r.addedNodes.length;
        if (added < 5) return;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => done(true), quiet);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      quietTimer = setTimeout(() => done(true), quiet);
      function done(ok) {
        clearTimeout(quietTimer);
        clearTimeout(hard);
        mo.disconnect();
        resolve(ok);
      }
    });
    return { data: { ready: true, quieted } };
  }

  async function doWait(p) {
    const timeout = p.timeout || 10000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (p.for === 'selector' && document.querySelector(p.value)) return { data: { text: `appeared: ${p.value}` } };
      if (p.for === 'text' && document.body.innerText.includes(p.value)) return { data: { text: `text appeared: ${p.value}` } };
      if (p.for === 'idle' && document.readyState === 'complete') {
        await sleep(500);
        return { data: { text: 'page finished loading' } };
      }
      await sleep(200);
    }
    throw fail('TIMEOUT', `Wait timed out (${timeout}ms): ${p.for} ${p.value || ''}`);
  }

  
  
  function scrollBoxes(selector) {
    if (selector) return [...document.querySelectorAll(selector)];
    
    
    return [...document.querySelectorAll('*')]
      .filter((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY))
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
      .slice(0, 6);
  }

  const describe = (e) =>
    `${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).trim().split(/\s+/)[0] : ''}(${e.scrollHeight})`;

  async function doScroll(p) {
    window.__hcCursor?.(null, null, 'scroll');   
    const times = Math.min(p.times || 1, 50);
    if (p.ref) {
      resolve(p).scrollIntoView({ block: 'center' });
      await sleep(p.wait || 500);
      return { data: { text: `scrolled to [${p.ref}]` } };
    }

    const boxes = scrollBoxes(p.selector);
    const height = () => document.body.scrollHeight + boxes.reduce((n, b) => n + b.scrollHeight, 0);
    const top = p.to === 'top';

    let last = -1, stable = 0, grew = false;
    const started = height();
    for (let i = 0; i < times; i++) {
      const before = height();
      window.scrollTo(0, top ? 0 : document.body.scrollHeight);
      for (const b of boxes) b.scrollTop = top ? 0 : b.scrollHeight;

      
      //
      
      
      
      
      
      
      
      const wheel = () => new WheelEvent('wheel', { deltaY: top ? -600 : 600, bubbles: true, cancelable: true });
      for (const b of boxes) {
        b.dispatchEvent(wheel());
        b.dispatchEvent(new Event('scroll'));   
      }
      document.body.dispatchEvent(wheel());
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
      
      
      
      
      
      const budget = p.wait || 700;
      const deadline = Date.now() + budget;
      while (Date.now() < deadline) {
        await sleep(80);
        if (height() > before) break;   
      }
      const h = height();
      if (h > started) grew = true;
      
      if (h === last) { if (++stable >= 2) return { data: { text: `Reached the bottom (pass ${i + 1}, height stable at ${h})\nScroll containers: ${boxes.map(describe).join(', ') || 'window only'}` } }; }
      else stable = 0;
      last = h;
    }
    return {
      data: {
        text: `Scrolled ${times} time(s), total height ${last}\nScroll containers: ${boxes.map(describe).join(', ') || 'window only'}\n`
          + (boxes.length ? '' : '(no inner scroll container found; if the list did not load more, pass selector to name the container)\n')
          + (grew ? '' :
            '⚠️ The height never changed. Possible causes: (1) times is too small (the default is 1 scroll; pass something like times:10 to load more); '
            + '(2) the list uses an IntersectionObserver to decide when to load, and a background tab produces no render frames, '
            + 'so the observer never fires; the only fix is focus:true to bring the tab to the front (it interrupts the user); '
            + '(3) there is simply no more content.'),
      },
    };
  }

  
  
  
  
  
  
  function findFileInput(p) {
    if (p.selector) return document.querySelector(p.selector);
    return [...document.querySelectorAll('input[type=file]')].find((el) => {
      const acc = el.getAttribute('accept') || '';
      return !acc || acc.split(',').some((a) => {
        a = a.trim();
        return a === '*/*' || (a.endsWith('/*') ? (p.type || '').startsWith(a.slice(0, -1)) : (a.startsWith('.') ? p.name.toLowerCase().endsWith(a) : a === p.type));
      });
    });
  }

  
  
  
  function doUploadTarget(p) {
    const input = findFileInput(p);
    
    if (!input || input.tagName !== 'INPUT') return { data: { drop: true } };
    const mark = 'hc' + Math.random().toString(36).slice(2, 10);
    input.setAttribute('data-hc-fi', mark);
    return { data: { selector: `input[data-hc-fi="${mark}"]`, accept: input.getAttribute('accept') || '' } };
  }

  function doUpload(p) {
    let bin;
    try {
      bin = atob(p.base64);
    } catch (e) {
      
      
      
      
      
      const b = p.base64;
      throw fail('INTERNAL',
        `atob decode failed: ${e.message}. Diagnosis: type=${typeof b}, `
        + `length=${b == null ? 'null/undefined' : b.length}, `
        + `start=${JSON.stringify(String(b).slice(0, 24))}, `
        + `end=${JSON.stringify(String(b).slice(-24))}.`);
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], p.name, { type: p.type || 'application/octet-stream' });

    
    
    
    if (p.dropSelector) return dropFile(file, p, bytes.length);

    const input = findFileInput(p);
    
    
    
    if (!input || (input.tagName !== 'INPUT' && !p.selector)) return dropFile(file, p, bytes.length);
    if (input.tagName !== 'INPUT') return dropFile(file, p, bytes.length, input);

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { data: { text: `Put ${p.name} (${Math.round(bytes.length / 1024)}KB) into ${input.getAttribute('accept') ? 'accept="' + input.getAttribute('accept') + '"' : ''} input` } };
  }

  
  
  
  function dropFile(file, p, bytes, hinted) {
    let target = hinted
      || (p.dropSelector && document.querySelector(p.dropSelector))
      || document.querySelector('[class*="drop" i],[class*="upload" i],[contenteditable="true"],[role="textbox"]')
      || document.activeElement
      || document.body;
    if (!target) {
      throw fail('REF_NOT_FOUND',
        'The page has no file input and no drop target that can be found. Open the upload entry point so one appears, '
        + 'or pass selector (the input) / dropSelector (the drop zone) to tell me where to put it.');
    }

    
    
    
    
    
    
    
    
    if (target.tagName !== 'INPUT' || target.type !== 'file') {
      const nested = target.querySelectorAll ? [...target.querySelectorAll('input[type=file]')] : [];
      if (nested.length === 1) {
        target = nested[0];
      } else if (nested.length > 1) {
        const tArea = target.getBoundingClientRect().width * target.getBoundingClientRect().height;
        target = nested
          .map((el) => { const r = el.getBoundingClientRect(); return { el, diff: Math.abs(r.width * r.height - tArea) }; })
          .sort((a, b) => a.diff - b.diff)[0].el;
      }
    }

    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = (type) => {
      const e = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt });
      target.dispatchEvent(e);
      return e;
    };
    ev('dragenter');
    const over = ev('dragover');
    ev('drop');
    return {
      data: {
        text: `Dropped ${p.name} (${Math.round(bytes / 1024)}KB) onto ${target.tagName.toLowerCase()}`
          + `${target.className ? '.' + String(target.className).trim().split(/\s+/)[0] : ''}. `
          + (over.defaultPrevented
            ? 'The page took over the drop (dragover was preventDefault-ed), so the target was right.'
            : '⚠️ The page did not take over dragover; you probably dropped in the wrong place. Use dropSelector to name the real drop zone.'),
      },
    };
  }

  
  
  
  
  
  
  
  
  function cssPath(el) {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && n !== document.body && i < 6; n = n.parentElement, i++) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      let s = n.tagName.toLowerCase();
      const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  }

  function refOfAncestor(el) {
    for (const [r, rec] of refMap) if (rec.el === el || rec.el?.contains?.(el)) return r;
    return '';
  }

  function queryByText(p) {
    const want = norm(p.contains).toLowerCase();
    if (!want) throw fail('INTERNAL', 'contains must not be empty');
    const limit = Math.min(Number(p.limit) || 20, 100);
    const roots = p.selector ? [...document.querySelectorAll(p.selector)] : [document.body];
    const hits = [];
    outer: for (const root of roots) {
      
      for (const el of root.querySelectorAll('input,textarea')) {
        if (String(el.value || '').toLowerCase().includes(want) && isVisible(el, undefined, true)) hits.push(el);
        if (hits.length >= limit) break outer;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!norm(node.nodeValue).toLowerCase().includes(want)) continue;
        const el = node.parentElement;
        if (!el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName) || !isVisible(el, undefined, true)) continue;
        if (!hits.includes(el)) hits.push(el);
        if (hits.length >= limit) break outer;
      }
    }
    if (!hits.length) return { data: { untrusted: true, text: `No visible "${p.contains}" on the page (shadow DOM and iframes are not searched)` } };
    const lines = hits.map((el) => {
      const t = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.innerText || '').replace(/\s+/g, ' ').trim();
      const role = roleOf(el);
      const st = INTERACTIVE_TAGS.has(el.tagName) || el.getAttribute('role') ? stateOf(el, role) : '';
      const within = refOfAncestor(el);
      return `${cssPath(el)}${st}  "${t.length > 160 ? t.slice(0, 160) + '…' : t}"${within ? `  ← inside [${within}]` : ''}`;
    });
    return { data: { untrusted: true, text: `${hits.length} match(es) for "${p.contains}" (selector path · text · enclosing numbered element):\n${lines.join('\n')}` } };
  }

  
  
  
  function doRead(p) {
    if (!p.ref && !p.find && !p.selector) return queryByText({ ...p, limit: p.limit || 10 });
    let el = null;
    if (p.find) {
      try { el = findEl(p.find); } catch (e) {
        
        if (p.find.name && !p.find.role) return queryByText({ contains: p.find.name, limit: 5 });
        throw e;
      }
    } else if (p.selector) el = document.querySelector(p.selector);
    else el = refMap.get(p.ref)?.el;
    if (!el || !el.isConnected) throw fail('REF_NOT_FOUND', `Cannot find ${p.ref || p.selector}`);
    const role = roleOf(el);
    const bits = [`${role} "${accessibleName(el)}"${stateOf(el, role)}${isVisible(el, undefined, true) ? '' : ' (not visible)'}`];
    if (p.attr) bits.push(`${p.attr}: ${JSON.stringify(readAttr(el, p.attr))}`);
    const text = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : el.innerText || '').replace(/\s+/g, ' ').trim();
    if (text) bits.push(`text: "${text.length > 400 ? text.slice(0, 400) + '…' : text}"`);
    return { data: { untrusted: true, text: bits.join('\n') } };
  }

  
  
  function doExpect(p) {
    const e = p.expect || {};
    let el = null;
    try {
      if (p.find) el = findEl(p.find);
      else if (p.selector) el = document.querySelector(p.selector);
      else if (p.ref) el = refMap.get(p.ref)?.el || null;
    } catch { el = null; }
    const alive = !!(el && el.isConnected && isVisible(el, undefined, true));
    const checks = [];
    if ('gone' in e) checks.push([!alive === !!e.gone, `gone=${!alive}`]);
    if (e.appears) {
      let seen = false;
      try { seen = !!document.querySelector(e.appears); } catch {  }
      if (!seen) seen = (document.body?.innerText || '').includes(e.appears);
      checks.push([seen, `appears(${e.appears})=${seen}`]);
    }
    if ('checked' in e || 'value' in e || 'text' in e) {
      if (!el) checks.push([false, 'target is not on the page']);
      else {
        if ('checked' in e) {
          const now = !!(el.checked ?? el.getAttribute('aria-checked') === 'true');
          checks.push([now === !!e.checked, `checked=${now}`]);
        }
        if ('value' in e) {
          const now = String(el.value ?? el.innerText ?? '').trim();
          checks.push([now === String(e.value) || now.includes(String(e.value)), `value=${JSON.stringify(now.slice(0, 80))}`]);
        }
        if ('text' in e) {
          const now = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
          checks.push([now.includes(String(e.text)), `text=${JSON.stringify(now.slice(0, 80))}`]);
        }
      }
    }
    if (!checks.length) return { data: { ok: true, text: '(empty expectation)' } };
    return { data: { ok: checks.every((c) => c[0]), text: checks.map((c) => c[1]).join(', ') } };
  }

  function doQuery(p) {
    if (p.contains) return queryByText(p);
    if (!p.selector) throw fail('INTERNAL', 'query needs selector or contains');
    const nodes = [...document.querySelectorAll(p.selector)].slice(0, p.limit || 100);
    if (p.html) {
      return { data: { untrusted: true, text: nodes.map((el, i) => `--- [${i}] ---\n` + el.outerHTML.slice(0, p.html === true ? 1200 : p.html)).join('\n\n') } };
    }
    const rows = nodes.map((el) => {
      if (!p.extract) return (el.innerText || '').replace(/\s+/g, ' ').trim();
      const row = {};
      for (const [key, spec] of Object.entries(p.extract)) {
        const [sel, attr] = String(spec).split('@');           
        const target = !sel || sel === '.' ? el : el.querySelector(sel);
        row[key] = !target ? null : attr ? readAttr(target, attr)
          : (target.innerText || '').replace(/\s+/g, ' ').trim();
      }
      return row;
    });
    return { data: { untrusted: true, text: JSON.stringify(rows, null, 1) } };
  }

  
  
  
  
  function readAttr(el, attr) {
    if (attr === 'value') return el.value ?? el.getAttribute('value');
    if (attr === 'checked') return el.checked ?? el.hasAttribute('checked');
    if (attr === 'text') return (el.innerText || '').replace(/\s+/g, ' ').trim();
    return el.getAttribute(attr);
  }

  
  function invalidate() {  }
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...a) { snapshotId = null; refMap.clear(); return orig.apply(this, a); };
  }
  window.addEventListener('popstate', () => { snapshotId = null; refMap.clear(); });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.__hc) return;
    (async () => {
      try {
        switch (msg.__hc) {
          case 'ping': return sendResponse({ pong: true });
          case 'snapshot': return sendResponse({ data: buildSnapshot() });
          case 'locate': return sendResponse({ data: await doLocate(msg) });
          
          
          case 'markTargets': {
            const selectors = [];
            (msg.targets || []).forEach((t, i) => {
              let el = null;
              try { el = refMap.get(t)?.el || document.querySelector(t); } catch {  }
              if (!el) return;
              el.setAttribute('data-hc-mark', String(i));
              selectors.push(`[data-hc-mark="${i}"]`);
            });
            return sendResponse({ data: { selectors } });
          }
          case 'unmarkTargets':
            document.querySelectorAll('[data-hc-mark]').forEach((el) => el.removeAttribute('data-hc-mark'));
            return sendResponse({ data: { ok: true } });
          case 'payGuard':
            if (msg.on) { armPayGuard(); return sendResponse({ data: { armed: true } }); }
            return sendResponse({ data: { blocked: disarmPayGuard() } });
          case 'effect': return sendResponse({ data: doEffect(msg) });
          case 'click': return sendResponse(await doClick(msg));
          case 'type': return sendResponse(doType(msg));
          case 'select': return sendResponse(doSelect(msg));
          case 'fill': return sendResponse(doFill(msg));
          case 'key': return sendResponse(doKey(msg));
          case 'ready': return sendResponse(await doReady(msg));
          case 'wait': return sendResponse(await doWait(msg));
          case 'query': return sendResponse(doQuery(msg));
          case 'read': return sendResponse(doRead(msg));
          case 'expect': return sendResponse(doExpect(msg));
          case 'upload': return sendResponse(doUpload(msg));
          case 'uploadTarget': return sendResponse(doUploadTarget(msg));
          case 'scroll': return sendResponse(await doScroll(msg));
          case 'history':
            if (msg.action === 'back') history.back();
            else if (msg.action === 'forward') history.forward();
            else location.reload();
            return sendResponse({ data: { text: 'ok' } });
          case 'read_text':
            return sendResponse({
              data: {
                untrusted: true,
                meta: `url="${location.href}"`,
                text: `# ${document.title}\n${location.href}\n\n` + (msg.format === 'text' ? mainText() : toMarkdown()),
              },
            });
          default:
            return sendResponse({ error: { code: 'INTERNAL', message: 'Unknown command ' + msg.__hc } });
        }
      } catch (e) {
        sendResponse({ error: { code: e.code || 'INTERNAL', message: e.message } });
      }
    })();
    return true; 
  });
})();
