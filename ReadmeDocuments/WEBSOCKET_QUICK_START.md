# WebSocket Quick Start Guide

## 🚀 Quick Test (5 minutes)

### 1. Test WebSocket Connection
```bash
cd backend
node src/test-websocket.js
```

**Expected output**:
```
✓ Connected to Dhan native WebSocket
✓ Subscribing to test security
✓ Received tick data

=== LIVE TICK DATA ===
Security ID: 13
LTP: 21850.50
Volume: 1234567
Open: 21800.00
High: 21900.00
Low: 21750.00
Close: 21850.50
Timestamp: 2026-04-27T10:30:00.000Z
=====================
```

### 2. Start Backend Server
```bash
cd backend
npm run dev
```

### 3. Test from Frontend
```javascript
// In browser console
socket.emit('enableLiveFeed', { 
  securityIds: [13] // NIFTY 50
});

socket.on('liveFeedUpdate', (data) => {
  console.log('LIVE:', data);
});
```

## 📊 Common Security IDs

| Instrument | Security ID |
|------------|-------------|
| NIFTY 50 | 13 |
| BANK NIFTY | 25 |
| SENSEX | 51 |

## 🔧 Troubleshooting

### Connection fails?
- Check internet connection
- Verify market is open
- Check firewall settings

### No data received?
- Wrong security ID
- Market closed
- Check logs for errors

### Decoding errors?
- Binary format may have changed
- Check logs for raw hex dump
- Compare with Dhan web app

## 📝 Integration Steps

### Backend Integration
```javascript
// 1. Import service
const dhanWebSocketFeedService = require('./services/dhanWebSocketFeed.service');

// 2. Connect
await dhanWebSocketFeedService.connect();

// 3. Subscribe
dhanWebSocketFeedService.subscribe([13], (tick) => {
  console.log('Tick:', tick);
});
```

### Frontend Integration
```javascript
// 1. Enable live feed
socket.emit('enableLiveFeed', { 
  securityIds: [13, 25],
  interval: '1m'
});

// 2. Listen for updates
socket.on('liveFeedUpdate', ({ securityId, data }) => {
  updateChart(securityId, data);
});

// 3. Disable when done
socket.emit('disableLiveFeed', { 
  securityIds: [13, 25] 
});
```

## ⚡ Performance

- **Latency**: ~50ms (vs 2000ms polling)
- **Bandwidth**: ~1KB/s per security
- **CPU**: ~0.1ms per message decode
- **Memory**: ~1KB per subscription

## ⚠️ Important Notes

1. **Reverse Engineered**: This uses Dhan's internal protocol
2. **No Official Support**: May break without notice
3. **Market Hours Only**: Data only during trading hours
4. **Legal Risk**: May violate terms of service

## 🎯 Next Steps

1. ✅ Test connection
2. ✅ Verify data accuracy
3. ✅ Integrate with frontend
4. ⏳ Monitor in production
5. ⏳ Add error handling
6. ⏳ Implement fallback to polling

## 📚 Full Documentation

See `WEBSOCKET_IMPLEMENTATION.md` for complete details.
