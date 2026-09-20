export function object(value: unknown, label = 'input'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 4000, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be a ${allowEmpty ? '' : 'nonempty '}string of at most ${max} characters`);
  }
  return value;
}
export function number(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`Number must be in [${min}, ${max}]`);
  return n;
}
export function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = number(value, fallback, min, max);
  if (!Number.isInteger(n)) throw new Error('Expected an integer');
  return n;
}
export function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Expected a boolean');
  return value;
}
export function strings(value: unknown, fallback: string[], max = 30): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > max) throw new Error(`Expected at most ${max} strings`);
  return value.map(v => text(v, 'list item', 500));
}
export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
export function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Cancelled'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
