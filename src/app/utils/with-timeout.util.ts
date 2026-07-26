/**
 * Firestore's SDK retries with backoff internally and its promises never reject on
 * their own when the backend is unreachable (e.g. misconfigured/placeholder Firebase
 * credentials) — callers would otherwise be stuck "loading" forever.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = 'Request timed out'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
