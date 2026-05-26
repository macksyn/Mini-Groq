# WhatsApp Presence Issue - Analysis & Fix

## Problem Summary
Your bot was staying **always online**, blocking native WhatsApp notifications even when you were offline. This was caused by automatic presence broadcasts from the Baileys library.

## Root Cause Analysis

### 1. **Baileys Default Configuration**
Location: `node_modules/@whiskeysockets/baileys/lib/Defaults/index.js` (line 51)
```javascript
markOnlineOnConnect: true,  // ❌ Default is TRUE
```

### 2. **Automatic Presence Broadcast on Connection**
Location: `node_modules/@whiskeysockets/baileys/lib/Socket/chats.js` (line 889)
```javascript
if (connection === 'open') {
    if (fireInitQueries) {
        executeInitQueries().catch(error => onUnexpectedError(error, 'init queries'));
    }
    // ❌ This sends global online/offline status on every connection
    sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable')
        .catch(error => onUnexpectedError(error, 'presence update requests'));
}
```

### 3. **Presence Types in Baileys**

Baileys uses TWO types of presence updates:

#### Global Presence (Full Account Status)
- **`'available'`** - Marks your account as ONLINE to all contacts
- **`'unavailable'`** - Marks your account as OFFLINE to all contacts
- ⚠️ These are broadcast to everyone and interfere with your real device status

#### Per-Chat Presence (Typing Indicators)
- **`'composing'`** - Shows "typing..." in a specific chat
- **`'paused'`** - Stops typing indicator in a specific chat
- **`'recording'`** - Shows "recording audio..." in a specific chat
- ✅ These are transaction-based and don't affect overall account status

## The Solution

### Changes Made

**1. Set `markOnlineOnConnect: false`** (Already done)
```typescript
const QasimDev = makeWASocket({
    // ... other config ...
    markOnlineOnConnect: false,  // ✅ Prevents default 'unavailable' broadcast
    // ... rest of config ...
});
```

**2. Enhanced `sendPresenceUpdate` Override** (Just updated)
```typescript
QasimDev.sendPresenceUpdate = async function (status: string, chatId: string, ...args: any[]) {
    const ghostMode = await store.getSetting('global', 'stealthMode');
    if (ghostMode && ghostMode.enabled) {
        printLog('info', '👻 Blocked presence update (stealth mode)');
        return;
    }
    
    // ✅ Block BOTH 'available' and 'unavailable' to prevent status broadcasts
    if (status === 'available' || status === 'unavailable') {
        return;  // Silently block these
    }
    
    // ✅ Allow only typing indicators (composing, paused, recording)
    return originalSendPresenceUpdate.apply(this, [status, chatId, ...args]);
};
```

## How It Works Now

```
┌─────────────────────────────────────────────────────────┐
│  Your Actual WhatsApp Status (From your phone)          │
│  - Online when device is on                             │
│  - Offline when device is off                           │
│  - "Last seen" updated normally                         │
└─────────────────────────────────────────────────────────┘
                           ▲
                           │
                    No interference from bot
                           │
┌─────────────────────────────────────────────────────────┐
│  Bot Behavior                                            │
├─────────────────────────────────────────────────────────┤
│  ❌ Blocked: 'available' status broadcasts              │
│  ❌ Blocked: 'unavailable' status broadcasts            │
│  ✅ Allowed: 'composing' (typing indicator)             │
│  ✅ Allowed: 'paused' (stopped typing)                  │
│  ✅ Allowed: 'recording' (recording audio)              │
└─────────────────────────────────────────────────────────┘
```

## Impact on Features

| Feature | Before Fix | After Fix |
|---------|-----------|-----------|
| **Presence** | Always online ❌ | Natural (device-based) ✅ |
| **Notifications** | Blocked ❌ | Working ✅ |
| **Typing Indicators** | N/A | Still works ✅ |
| **Auto-reply** | Works | Works ✅ |
| **Autotyping** | Works | Works (only per-chat) ✅ |
| **Stealth Mode** | Works | Works ✅ |

## Baileys Version Information

- **Package**: `@whiskeysockets/baileys`
- **Version**: `7.0.0-rc.9`
- **Issue**: This is library behavior, not a bug per se, but the default prevents real presence

## Additional Safeguards

The wrapper also:
1. Respects **Stealth Mode** - blocks all presence when enabled
2. Blocks any global status broadcasts, even if called from plugins
3. Preserves typing indicators for better UX in auto-reply scenarios

## Testing Recommendations

1. **Restart your bot** - Changes require reconnection
2. **Turn off your phone** - Check if notifications work when offline
3. **Verify your status** - Open WhatsApp and check if you show "Last seen 2 hours ago" instead of "Online"
4. **Test typing indicators** - Enable autotyping and verify "typing..." still shows
5. **Check notifications** - Send yourself a message and verify it triggers a notification

## Files Modified

- `index.ts` - Updated presence handler override
- `node_modules/@whiskeysockets/baileys/lib/Defaults/index.js` - (Not modified, just documented)
- `node_modules/@whiskeysockets/baileys/lib/Socket/chats.js` - (Not modified, just documented)
