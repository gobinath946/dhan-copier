/**
 * NSE Indian market hours check (IST 9:15 - 15:30, Mon-Fri).
 * Holidays not supported here — engine relies on live data calls failing gracefully on holidays.
 */
function nowInIST() {
  // IST is UTC+5:30
  const utcMs = Date.now();
  return new Date(utcMs + 5.5 * 60 * 60 * 1000);
}

function isMarketOpen() {
  const ist = nowInIST();
  const day = ist.getUTCDay(); // 0=Sun, 6=Sat (we shifted so use UTC getters)
  if (day === 0 || day === 6) return { open: false, reason: 'Weekend' };

  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const openMin = 9 * 60 + 15;
  const closeMin = 15 * 60 + 30;

  if (minutes < openMin) return { open: false, reason: 'Pre-market' };
  if (minutes >= closeMin) return { open: false, reason: 'Market closed' };

  // Close approaching: leave 5 min buffer
  const closingSoon = minutes >= closeMin - 5;
  return { open: true, closingSoon, ist: ist.toISOString() };
}

module.exports = { isMarketOpen, nowInIST };
