import type { Config, Candidate, Snapshot, Mission } from './types.js';

export const RISKY = /delete|remove|purchase|pay\b|checkout|send\b|invite|publish|删除|移除|付款|支付|下单|发送|邀请|发布/i;
export const PRIVATE = /password|passwd|secret|token|credential|api.?key|密码|密钥|令牌/i;
export function assertUrl(url: string, c: Config): void {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !c.allowedOrigins.includes(u.origin)) {
    throw new Error('Navigation blocked: URL is not in operator-configured allowedOrigins');
  }
  for (const key of u.searchParams.keys()) {
    if (PRIVATE.test(key)) throw new Error('Do not put credentials in the test URL; use a dedicated test session');
  }
}
export function permittedRequest(url: string, c: Config, navigation: boolean): boolean {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
    return (navigation ? c.allowedOrigins : [...c.allowedOrigins, ...c.resourceOrigins]).includes(u.origin);
  } catch { return false; }
}
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw); u.username = ''; u.password = '';
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '[redacted]');
    if (u.hash) u.hash = '[redacted]';
    return u.toString();
  } catch { return '[invalid URL]'; }
}
export function makeRedactor(env = process.env): (value: string) => string {
  const names = ['TYPESAFE_API_KEY', ...(env.QA_REDACT_ENV || '').split(',').map(s => s.trim())];
  const secrets = names.map(n => env[n]).filter((v): v is string => Boolean(v && v.length >= 4));
  return value => {
    let out = value.replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [redacted]')
      .replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;"}]+/gi, '$1[redacted]');
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
    return out;
  };
}
export function buildCandidates(s: Snapshot, m: Mission, c: Config): Candidate[] {
  const out: Candidate[] = [];
  const add = (a: Omit<Candidate, 'id'>) => { if (out.length < 235) out.push({ ...a, id: `a${out.length}` }); };
  for (const t of s.targets) {
    if (PRIVATE.test(`${t.type} ${t.label}`) || (!c.allowRiskyActions && RISKY.test(t.label))) continue;
    const editable = t.tag === 'textarea' || t.role === 'textbox' || (t.tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(t.type));
    if (editable) {
      for (const input of m.inputs) {
        if (input.field !== '*' && !`${t.label} ${t.locator}`.toLowerCase().includes(input.field.toLowerCase())) continue;
        add({ kind: 'fill', target: t, value: input.value, description: `Fill ${t.label} with supplied case ${JSON.stringify(input.value.slice(0, 120))} (${input.value.length} chars); preserve this exact input` });
      }
    } else if (t.tag === 'select') {
      for (const option of t.options ?? []) add({ kind: 'select', target: t, value: option.value, description: `Select ${option.label} in ${t.label}` });
    } else {
      add({ kind: 'click', target: t, description: `Click ${t.label} (${t.role || t.tag})` });
      if (m.burstClicks > 1 && (t.tag === 'button' || t.type === 'submit')) {
        add({ kind: 'burst_click', target: t, count: m.burstClicks, description: `Attempt ${m.burstClicks} consecutive user-level clicks on ${t.label}; stop if not actionable` });
      }
    }
  }
  add({ kind: 'press', value: 'Escape', description: 'Press Escape to dismiss current UI, if that matches the mission' });
  add({ kind: 'scroll', value: 'down', description: 'Scroll down to reveal more controls' });
  add({ kind: 'scroll', value: 'up', description: 'Scroll up' });
  add({ kind: 'wait', description: 'Wait briefly for pending UI changes' });
  if (m.allowReload) {
    add({ kind: 'reload', description: 'Reload current page; only for the explicit recovery/persistence mission' });
    add({ kind: 'back', description: 'Navigate back within the allowed test origins' });
  }
  out.push({ id: 'done', kind: 'done', description: 'Local objective explored; yield to supervisor. This is NOT a test pass.' });
  out.push({ id: 'blocked', kind: 'blocked', description: 'No unambiguous permitted action; request supervisor guidance.' });
  return out;
}

/** Redact string values without corrupting JSON quoting or changing object keys. */
export function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]));
  return value;
}
