
//

//

//

//

//

export const MARK_PALETTE = [
  { emoji: '🟣', color: '#a855f7', group: 'purple' },
  { emoji: '🟢', color: '#22c55e', group: 'green' },
  { emoji: '🔵', color: '#3b82f6', group: 'blue' },
  { emoji: '🟠', color: '#f97316', group: 'orange' },
  { emoji: '🔴', color: '#ef4444', group: 'red' },
  { emoji: '🟡', color: '#eab308', group: 'yellow' },
  { emoji: '🟤', color: '#a16207', group: 'grey' },
  { emoji: '🟪', color: '#a855f7', group: 'purple' },
  { emoji: '🟩', color: '#22c55e', group: 'green' },
  { emoji: '🟦', color: '#3b82f6', group: 'blue' },
  { emoji: '🟧', color: '#f97316', group: 'orange' },
  { emoji: '🟥', color: '#ef4444', group: 'red' },
  { emoji: '🟨', color: '#eab308', group: 'yellow' },
  { emoji: '🟫', color: '#a16207', group: 'grey' },
];

//

export const MARK_SENTINEL = '\u2009';

export function stripMarkPrefix(title) {
  const s = String(title || '');
  const i = s.indexOf(MARK_SENTINEL);
  return i >= 0 && i <= 12 ? s.slice(i + 1) : s;
}

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function prettyClient(client) {
  const c = String(client || '').trim();
  if (!c || c === 'unknown') return 'AI agent';
  if (/[A-Z]/.test(c)) return c;
  return c.split(/[-_\s]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function identityOf(sid, client) {
  const s = String(sid ?? '');
  const i = s.indexOf(':');
  const slug = client || (i > 0 ? s.slice(0, i) : '');
  const code = i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s.slice(-6);
  const p = MARK_PALETTE[hash32(s) % MARK_PALETTE.length];
  return { sid: s, emoji: p.emoji, color: p.color, group: p.group, label: prettyClient(slug), code };
}
