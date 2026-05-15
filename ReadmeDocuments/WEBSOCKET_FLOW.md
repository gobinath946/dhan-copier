# WebSocket Data Flow

## Connection Flow

```
┌─────────────────┐
│   Frontend      │
│   (Browser)     │
└────────┬────────┘
         │ socket.emit('enableLiveFeed')
         ↓
┌─────────────────┐
│   server.js     │
│   (Socket.IO)   │
└────────┬────────┘
         │ dhanWebSocketFeedService.connect()
         ↓
┌─────────────────────────────────────┐
│  dhanWebSocketFeed.service.js       │
│  new WebSocket(wss://...)           │
└────────┬────────────────────────────┘
         │ WebSocket handshake
         ↓
┌─────────────────────────────────────┐
│  Dhan WebSocket Server              │
│  wss://price-feed-tv.dhan.co        │
└─────────────────────────────────────┘
```

## Subscription Flow

```
Frontend                Server.js              WebSocket Service         Dhan Server
   │                       │                          │                      │
   │ enableLiveFeed        │                          │                      │
   ├──────────────────────>│                          │                      │
   │                       │ subscribe([13])          │                      │
   │                       ├─────────────────────────>│                      │
   │                       │                          │ {"action":"subscribe"}│
   │                       │                          ├─────────────────────>│
   │                       │                          │                      │
   │                       │                          │      ACK             │
   │                       │                          │<─────────────────────┤
   │ liveFeedStatus        │                          │                      │
   │<──────────────────────┤                          │                      │
   │ {success: true}       │                          │                      │
```

## Real-time Data Flow

```
Dhan Server          WebSocket Service         Server.js            Frontend
    │                       │                       │                   │
    │ Binary Message        │                       │                   │
    │ [0x01, 0x0D, ...]     │                       │                   │
    ├──────────────────────>│                       │                   │
    │                       │ decodeBinaryMessage() │                   │
    │                       │ {                     │                   │
    │                       │   type: 'tick',       │                   │
    │                       │   securityId: 13,     │                   │
    │                       │   ltp: 21850.50,      │                   │
    │                       │   volume: 1234567     │                   │
    │                       │ }                     │                   │
    │                       │                       │                   │
    │                       │ callback(tick)        │                   │
    │                       ├──────────────────────>│                   │
    │                       │                       │ liveFeedUpdate    │
    │                       │                       ├──────────────────>│
    │                       │                       │ {                 │
    │                       │                       │   securityId: 13, │
    │                       │                       │   data: {...}     │
    │                       │                       │ }                 │
    │                       │                       │                   │
    │                       │                       │                   │ updateChart()
```

## Heartbeat Flow

```
WebSocket Service                    Dhan Server
       │                                  │
       │ setInterval(30s)                 │
       │                                  │
       │ Send: [0x20]                     │
       ├─────────────────────────────────>│
       │                                  │
       │                                  │ Receive: [0x20]
       │                                  │ (Keep connection alive)
       │                                  │
       │ Receive: [0x20]                  │
       │<─────────────────────────────────┤
       │                                  │
       │ Send: [0x20]                     │
       ├─────────────────────────────────>│
       │                                  │
```

## Reconnection Flow

```
WebSocket Service                    Dhan Server
       │                                  │
       │ Connected                        │
       │<────────────────────────────────>│
       │                                  │
       │                                  │ Connection Lost
       │                                  │ (Network issue)
       │ onclose event                    │
       │                                  │
       │ attemptReconnect()               │
       │ Wait 1s                          │
       │                                  │
       │ Reconnect attempt 1              │
       ├─────────────────────────────────>│
       │                                  │ Failed
       │                                  │
       │ Wait 2s                          │
       │                                  │
       │ Reconnect attempt 2              │
       ├─────────────────────────────────>│
       │                                  │ Success!
       │ Connected                        │
       │<────────────────────────────────>│
       │                                  │
       │ Resubscribe to all securities    │
       ├─────────────────────────────────>│
```

## Binary Message Decoding

```
Raw Binary Message:
┌──────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│ 0x01 │ 0x0D 0x00│ 0x00 0x00│ 0x42 0x55│ 0x00 0x00│ 0x42 0x54│ 0x42 0x56│ 0x42 0x52│ 0x42 0x55│
│ Type │ Sec ID   │ LTP      │ Volume   │ Open     │ High     │ Low      │ Close    │ Time     │
└──────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
  1B      4B         4B         4B         4B         4B         4B         4B         4B

Decoded JSON:
{
  "type": "tick",
  "securityId": 13,
  "ltp": 21850.50,
  "volume": 1234567,
  "open": 21800.00,
  "high": 21900.00,
  "low": 21750.00,
  "close": 21850.50,
  "timestamp": 1714212600
}
```

## Multi-Client Subscription

```
Client 1                Server.js              WebSocket Service         Dhan Server
   │                       │                          │                      │
   │ subscribe([13])       │                          │                      │
   ├──────────────────────>│                          │                      │
   │                       │ subscribe([13], cb1)     │                      │
   │                       ├─────────────────────────>│                      │
   │                       │                          │ {"action":"subscribe"}│
   │                       │                          ├─────────────────────>│
   │                       │                          │                      │

Client 2                   │                          │                      │
   │                       │                          │                      │
   │ subscribe([13])       │                          │                      │
   ├──────────────────────>│                          │                      │
   │                       │ subscribe([13], cb2)     │                      │
   │                       ├─────────────────────────>│                      │
   │                       │ (No duplicate subscribe) │                      │
   │                       │                          │                      │
   │                       │                          │                      │
   │                       │                          │ Tick for 13          │
   │                       │                          │<─────────────────────┤
   │                       │                          │                      │
   │                       │ cb1(tick)                │                      │
   │                       │<─────────────────────────┤                      │
   │                       │ cb2(tick)                │                      │
   │                       │<─────────────────────────┤                      │
   │                       │                          │                      │
   │ liveFeedUpdate        │                          │                      │
   │<──────────────────────┤                          │                      │
   │                       │ liveFeedUpdate           │                      │
   │                       ├─────────────────────────>│                      │
```

## Error Handling Flow

```
WebSocket Service                    Dhan Server
       │                                  │
       │ Send message                     │
       ├─────────────────────────────────>│
       │                                  │
       │                                  │ Error response
       │ onerror event                    │
       │<─────────────────────────────────┤
       │                                  │
       │ Log error                        │
       │ Attempt reconnect                │
       │                                  │
       │ Reconnect                        │
       ├─────────────────────────────────>│
       │                                  │
       │ Connected                        │
       │<────────────────────────────────>│
       │                                  │
       │ Restore subscriptions            │
       ├─────────────────────────────────>│
```

## Graceful Shutdown Flow

```
Server.js              WebSocket Service         Dhan Server
    │                       │                      │
    │ SIGTERM/SIGINT        │                      │
    │                       │                      │
    │ disconnect()          │                      │
    ├──────────────────────>│                      │
    │                       │ stopHeartbeat()      │
    │                       │                      │
    │                       │ ws.close()           │
    │                       ├─────────────────────>│
    │                       │                      │
    │                       │ Close ACK            │
    │                       │<─────────────────────┤
    │                       │                      │
    │                       │ Clear subscriptions  │
    │                       │                      │
    │ server.close()        │                      │
    │                       │                      │
    │ process.exit(0)       │                      │
```

## Complete System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │   Chart      │  │  Live Feed   │  │   Controls   │         │
│  │  Component   │  │   Toggle     │  │   Panel      │         │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘         │
│         │                  │                  │                 │
│         └──────────────────┴──────────────────┘                 │
│                            │                                    │
│                    Socket.IO Client                             │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ WebSocket (Socket.IO)
                             │
┌────────────────────────────┴────────────────────────────────────┐
│                      Backend (Node.js)                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     server.js                            │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │            Socket.IO Server                        │  │  │
│  │  │  - Handle connections                              │  │  │
│  │  │  - Route messages                                  │  │  │
│  │  │  - Track subscriptions                             │  │  │
│  │  └────────────────┬───────────────────────────────────┘  │  │
│  └───────────────────┼──────────────────────────────────────┘  │
│                      │                                          │
│  ┌───────────────────┴──────────────────────────────────────┐  │
│  │         dhanWebSocketFeed.service.js                     │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  Connection Management                             │  │  │
│  │  │  - Connect/Disconnect                              │  │  │
│  │  │  - Reconnection logic                              │  │  │
│  │  │  - Heartbeat                                       │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  Subscription Management                           │  │  │
│  │  │  - Subscribe/Unsubscribe                           │  │  │
│  │  │  - Callback routing                                │  │  │
│  │  │  - Multi-client support                            │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  Binary Message Decoder                            │  │  │
│  │  │  - Tick data (0x01)                                │  │  │
│  │  │  - Heartbeat (0x20)                                │  │  │
│  │  │  - Depth data (0x02) [TODO]                        │  │  │
│  │  │  - Trade data (0x03) [TODO]                        │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────┬───────────────────────────────────┘  │
└─────────────────────────┼──────────────────────────────────────┘
                          │
                          │ WebSocket (Binary)
                          │
┌─────────────────────────┴──────────────────────────────────────┐
│                  Dhan WebSocket Server                          │
│              wss://price-feed-tv.dhan.co                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  - Market data feed                                      │  │
│  │  - Binary protocol                                       │  │
│  │  - Real-time ticks                                       │  │
│  │  - Heartbeat support                                     │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Message Types

### 1. Subscription Messages (JSON)
```
Client → Server:
{
  "action": "subscribe",
  "symbols": [13, 25, 1333]
}

Client → Server:
{
  "action": "unsubscribe",
  "symbols": [13]
}
```

### 2. Tick Data (Binary)
```
Server → Client:
[0x01, 0x0D, 0x00, 0x00, 0x00, ...]
│      │                         │
│      └─ Security ID (13)       └─ Price, Volume, OHLC data
└─ Message Type (Tick)
```

### 3. Heartbeat (Binary)
```
Client ↔ Server:
[0x20]
│
└─ Heartbeat/Ping
```

## State Management

```
WebSocket Service State:
┌─────────────────────────────────┐
│ isConnected: boolean            │
│ reconnectAttempts: number       │
│ subscriptions: Map<id, [cb]>    │
│ ws: WebSocket                   │
│ heartbeatInterval: Timer        │
└─────────────────────────────────┘

Server State:
┌─────────────────────────────────┐
│ liveSubscriptions: Map          │
│   socketId → [                  │
│     {securityIds, callback}     │
│   ]                             │
└─────────────────────────────────┘
```
