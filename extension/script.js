
//

//

//

export const REPEAT_MAX = 25;       
export const REPEAT_DEFAULT = 10;   
export const EXEC_BUDGET = 60;      

const BLOCKS = new Set(['repeat', 'if', 'assert']);

export const repeatMax = (st) => Math.min(Math.max(Number(st.max) || REPEAT_DEFAULT, 1), REPEAT_MAX);

export function validateScript(steps) {
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    if (st.do === 'repeat') {
      const inner = st.steps;
      if (!Array.isArray(inner) || !inner.length) return `step ${i + 1}: repeat has no sub-steps`;
      for (const s of inner) {
        if (BLOCKS.has(s?.do)) return `step ${i + 1}: repeat contains a nested ${s.do}; control blocks may only be one level deep, split into several act calls`;
        if (s?.ref && !s?.find) return `step ${i + 1}: a repeat sub-step uses ref="${s.ref}"; the page changes every pass, so use find (role + name) or selector`;
      }
    }
    if (st.do === 'read') {
      if (!st.ref && !st.find && !st.selector && !st.contains) {
        return `step ${i + 1}: read does not say what to read: give ref / find / selector for one element, or contains to search by text`;
      }
    }
    if (st.do === 'if') {
      if (!st.cond) return `step ${i + 1}: if has no cond`;
      for (const s of [...(st.then || []), ...(st.else || [])]) {
        if (BLOCKS.has(s?.do)) return `step ${i + 1}: if branch contains a nested ${s.do}; control blocks may only be one level deep, split into several act calls`;
      }
      if (!Array.isArray(st.then) || !st.then.length) return `step ${i + 1}: if has no then branch`;
    }
    if (st.do === 'assert' && !st.cond) return `step ${i + 1}: assert has no cond`;
  }
  return null;
}

export function flatCount(steps) {
  return (Array.isArray(steps) ? steps : []).reduce((n, st) => {
    if (st?.do === 'repeat') return n + repeatMax(st) * (st.steps?.length || 1);
    if (st?.do === 'if') return n + Math.max(st.then?.length || 0, st.else?.length || 0, 1);
    return n + 1;
  }, 0);
}

export function condText(cond) {
  if (!cond || typeof cond !== 'object') return '';
  const parts = [];
  if (cond.urlContains) parts.push(`url contains "${String(cond.urlContains).slice(0, 30)}"`);
  if (cond.selectorExists) parts.push(`has ${String(cond.selectorExists).slice(0, 30)}`);
  if (cond.textContains) parts.push(`text contains "${String(cond.textContains).slice(0, 20)}"`);
  if (cond.ref || cond.selector) {
    const who = cond.ref ? `[${cond.ref}]` : `(${String(cond.selector).slice(0, 30)})`;
    for (const k of ['checked', 'value', 'text']) if (k in cond) parts.push(`${who} ${k}=${JSON.stringify(cond[k]).slice(0, 30)}`);
  }
  const s = parts.join(' or ') || '(empty condition)';
  return cond.not ? `not (${s})` : s;
}
