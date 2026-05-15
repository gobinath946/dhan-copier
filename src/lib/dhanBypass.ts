/**
 * Dhan Bypass Auth Key Management
 * Stores and retrieves auth key from session storage
 */

const DHAN_BYPASS_KEY = 'dhanBypassAuthKey';

/**
 * Get the stored Dhan Bypass auth key
 */
export function getDhanBypassKey(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(DHAN_BYPASS_KEY);
}

/**
 * Save the Dhan Bypass auth key
 */
export function setDhanBypassKey(key: string): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(DHAN_BYPASS_KEY, key);
}

/**
 * Clear the Dhan Bypass auth key
 */
export function clearDhanBypassKey(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(DHAN_BYPASS_KEY);
}

/**
 * Check if Dhan Bypass is enabled
 */
export function isDhanBypassEnabled(): boolean {
  const key = getDhanBypassKey();
  return key !== null && key.length > 0;
}
