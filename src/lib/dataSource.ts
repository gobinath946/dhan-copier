/**
 * Data source management utilities
 * Handles session storage for chart data source preference
 */

export type DataSource = 'dhan' | 'yahoo' | 'dhan-bypass';

const DATA_SOURCE_KEY = 'chartDataSource';

/**
 * Get the stored data source preference
 * @returns The stored data source or 'dhan' as default
 */
export function getDataSource(): DataSource {
  if (typeof window === 'undefined') return 'dhan';
  
  const stored = sessionStorage.getItem(DATA_SOURCE_KEY);
  return (stored === 'dhan' || stored === 'yahoo' || stored === 'dhan-bypass') ? stored : 'dhan';
}

/**
 * Save the data source preference
 * @param source - The data source to save
 */
export function setDataSource(source: DataSource): void {
  if (typeof window === 'undefined') return;
  
  sessionStorage.setItem(DATA_SOURCE_KEY, source);
}

/**
 * Clear the data source preference
 */
export function clearDataSource(): void {
  if (typeof window === 'undefined') return;
  
  sessionStorage.removeItem(DATA_SOURCE_KEY);
}

/**
 * Get display name for data source
 * @param source - The data source
 * @returns Human-readable name
 */
export function getDataSourceDisplayName(source: DataSource): string {
  switch (source) {
    case 'dhan':
      return 'Dhan API';
    case 'yahoo':
      return 'Yahoo Finance';
    case 'dhan-bypass':
      return 'Dhan Bypass';
    default:
      return 'Unknown';
  }
}
