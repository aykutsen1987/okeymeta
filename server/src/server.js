'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager, DISCONNECT_GRACE_MS } = require('./rooms');
const { drawFromPile, drawFromDiscard, discardTile, checkWin } = require('./engine');

const PORT = process.env.PORT || 8080;
const roomManager = new RoomManager();

// ---------------------------------------------------------------------------
// HTTP: a plain health-check endpoint. Render (and any uptime monitor) pings
// this to know the service is alive; it's also just a friendly landing page.
// ---------------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'okeymeta-online-server',
    rooms: roomManager.rooms.size
  }));
});

const wss = new WebSocketServer({ server: httpServer });

// playerId -> { socket, roomCode }
const connections = new Map();

wss.on('connection', (socket) => {
  let playerId = null;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      sendError(socket, 'Gecersiz mesaj formati.');
      return;
    }

    try {
      switch (msg.type) {
        case 'create_room':
          playerId = handleCreateRoom(socket, msg);
          break;
        case 'join_room':
          playerId = handleJoinRoom(socket, msg);
          break;
        case 'quick_match':
          playerId = handleQuickMatch(socket, msg);
          break;
        case 'start_room':
          handleStartRoom(playerId);
          break;
        case 'draw_tile':
          handleDrawTile(playerId, msg);
          break;
        case 'discard_tile':
          handleDiscardTile(playerId, msg);
          break;
        case 'declare_win':
          handleDeclareWin(playerId);
          break;
        case 'chat':
          handleChat(playerId, msg);
          break;
        case 'reconnect':
          playerId = handleReconnect(socket, msg);
          break;
        case 'leave_room':
          handleLeaveRoom(playerId);
          break;
        default:
          sendError(socket, `Bilinmeyen mesaj tipi: ${msg.type}`);
      }
    } catch (err) {
      console.error('Message handling error:', err);
      sendError(socket, 'Sunucu tarafinda beklenmeyen bir hata olustu.');
    }
  });

  socket.on('close', () => {
    if (playerId) handleDisconnect(playerId);
  });
});

// ---------------------------------------------------------------------------
// Intent handlers
// ---------------------------------------------------------------------------

function handleCreateRoom(socket, msg) {
  const room = roomManager.createPrivateRoom();
  const playerId = newPlayerId();
  const displayName = safeName(msg.displayName);
  const entry = room.addPlayer(playerId, displayName, socket);
  connections.set(playerId, { socket, roomCode: room.code });

  send(socket, { type: 'room_created', roomCode: room.code, playerId, seat: entry.seat });
  broadcastWaitingUpdate(room);
  return playerId;
}

function handleJoinRoom(socket, msg) {
  const code = String(msg.roomCode || '').toUpperCase();
  const room = roomManager.getRoom(code);
  if (!room) {
    sendError(socket, 'Oda bulunamadi. Kodu kontrol edip tekrar deneyin.');
    return null;
  }
  if (room.isFull() || room.hasStarted()) {
    sendError(socket, 'Bu oda dolu veya oyun zaten basladi.');
    return null;
  }

  const playerId = newPlayerId();
  const displayName = safeName(msg.displayName);
  const entry = room.addPlayer(playerId, displayName, socket);
  connections.set(playerId, { socket, roomCode: room.code });

  send(socket, { type: 'room_created', roomCode: room.code, playerId, seat: entry.seat });
  room.broadcast(playerId, () => ({ type: 'player_joined', playerId, slot: entry.seat, displayName }));
  broadcastWaitingUpdate(room);

  if (room.isFull()) startRoomHand(room);
  return playerId;
}

function handleQuickMatch(socket, msg) {
  const room = roomManager.findOrCreateQuickMatchRoom();
  const playerId = newPlayerId();
  const displayName = safeName(msg.displayName);
  const entry = room.addPlayer(playerId, displayName, socket);
  connections.set(playerId, { socket, roomCode: room.code });

  send(socket, { type: 'room_created', roomCode: room.code, playerId, seat: entry.seat });
  room.broadcast(playerId, () => ({ type: 'player_joined', playerId, slot: entry.seat, displayName }));
  broadcastWaitingUpdate(room);

  if (room.isFull()) {
    roomManager.removeFromQuickMatchQueue(room);
    startRoomHand(room);
  }
  return playerId;
}

/** Host-triggered early start: fills any empty seats with AI bots so nobody's stuck
 *  waiting forever for a full table of humans. */
function handleStartRoom(playerId) {
  const room = roomOf(playerId);
  if (!room || room.hasStarted()) return;
  roomManager.removeFromQuickMatchQueue(room);
  room.fillRemainingWithBots();
  startRoomHand(room);
}

function startRoomHand(room) {
  const state = room.startHand();
  room.sendToAll((viewerId) => ({ type: 'state_sync', state: maskStateFor(state, viewerId) }));
  room.sendToAll(() => ({ type: 'turn_started', activePlayerId: state.turn.activePlayerId, timeLimitSeconds: state.turn.timeLimitSeconds }));
}

function handleDrawTile(playerId, msg) {
  const room = roomOf(playerId);
  if (!room || !room.gameState) return;
  if (room.gameState.turn.activePlayerId !== playerId) {
    sendErrorTo(playerId, 'Sira sizde degil.');
    return;
  }
  const state = msg.fromDiscard ? drawFromDiscard(room.gameState) : drawFromPile(room.gameState);
  room.sendToAll((viewerId) => ({ type: 'state_sync', state: maskStateFor(state, viewerId) }));
  room.sendToAll(() => ({ type: 'tile_drawn', fromDiscard: !!msg.fromDiscard }));
}

function handleDiscardTile(playerId, msg) {
  const room = roomOf(playerId);
  if (!room || !room.gameState) return;
  if (room.gameState.turn.activePlayerId !== playerId) {
    sendErrorTo(playerId, 'Sira sizde degil.');
    return;
  }
  const state = discardTile(room.gameState, msg.tileId);
  room.sendToAll((viewerId) => ({ type: 'state_sync', state: maskStateFor(state, viewerId) }));
  room.sendToAll(() => ({ type: 'tile_discarded', tileId: msg.tileId, nextPlayerId: state.turn.activePlayerId }));
  room.sendToAll(() => ({ type: 'turn_started', activePlayerId: state.turn.activePlayerId, timeLimitSeconds: state.turn.timeLimitSeconds }));
  maybeRunBotTurns(room);
}

function handleDeclareWin(playerId) {
  const room = roomOf(playerId);
  if (!room || !room.gameState) return;
  const player = room.gameState.players.find((p) => p.id === playerId);
  if (!player || !checkWin(player.hand)) {
    sendErrorTo(playerId, 'Elinizle bitis yapilamaz — kombinasyonlari kontrol edin.');
    return;
  }
  finishRound(room, playerId);
}

function handleChat(playerId, msg) {
  const room = roomOf(playerId);
  if (!room) return;
  const text = String(msg.text || '').slice(0, 300);
  if (!text.trim()) return;
  room.sendToAll(() => ({ type: 'chat_received', playerId, text }));
}

function handleReconnect(socket, msg) {
  const room = roomManager.getRoom(String(msg.roomCode || '').toUpperCase());
  const playerId = msg.playerId;
  if (!room || !playerId || !room.players.has(playerId)) {
    sendError(socket, 'Yeniden baglanilamadi: oda veya oyuncu bulunamadi.');
    return null;
  }
  const entry = room.players.get(playerId);
  entry.socket = socket;
  entry.connected = true;
  connections.set(playerId, { socket, roomCode: room.code });

  const timer = room.disconnectTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    room.disconnectTimers.delete(playerId);
  }
  if (room.gameState) {
    const player = room.gameState.players.find((p) => p.id === playerId);
    if (player) player.connectionStatus = 'CONNECTED';
    send(socket, { type: 'state_sync', state: maskStateFor(room.gameState, playerId) });
  }
  room.broadcast(playerId, () => ({ type: 'player_joined', playerId, slot: entry.seat, displayName: entry.name }));
  return playerId;
}

function handleLeaveRoom(playerId) {
  if (!playerId) return;
  const room = roomOf(playerId);
  if (!room) return;
  room.removePlayer(playerId);
  connections.delete(playerId);
  room.broadcast(playerId, () => ({ type: 'player_left', playerId }));
  broadcastWaitingUpdate(room);
  roomManager.destroyRoomIfEmpty(room);
}

function handleDisconnect(playerId) {
  if (!playerId) return;
  const room = roomOf(playerId);
  if (!room) return;
  const entry = room.players.get(playerId);
  if (!entry) return;
  entry.connected = false;

  if (room.gameState) {
    const player = room.gameState.players.find((p) => p.id === playerId);
    if (player) player.connectionStatus = 'RECONNECTING';
    room.broadcast(playerId, () => ({ type: 'reconnecting' }));

    // Grace period so a brief network hiccup doesn't evict a mid-hand player immediately.
    const timer = setTimeout(() => {
      handleLeaveRoom(playerId);
    }, DISCONNECT_GRACE_MS);
    room.disconnectTimers.set(playerId, timer);
  } else {
    // Still in the lobby (hand hasn't started) — safe to free the seat right away.
    handleLeaveRoom(playerId);
  }
}

// ---------------------------------------------------------------------------
// Very light "bot plays its turn" loop for AI seats added via handleStartRoom.
// Keeps the table moving instead of stalling forever on an AI-held seat.
// ---------------------------------------------------------------------------
function maybeRunBotTurns(room) {
  const state = room.gameState;
  if (!state || state.isRoundOver) return;
  const active = state.players.find((p) => p.id === state.turn.activePlayerId);
  if (!active || active.kind !== 'AI') return;

  setTimeout(() => {
    if (!room.gameState || room.gameState.turn.activePlayerId !== active.id) return;
    const s1 = drawFromPile(room.gameState);
    room.sendToAll((viewerId) => ({ type: 'state_sync', state: maskStateFor(s1, viewerId) }));
    room.sendToAll(() => ({ type: 'tile_drawn', fromDiscard: false }));

    const refreshed = s1.players.find((p) => p.id === active.id);
    const discardTileChoice = refreshed.hand[Math.floor(Math.random() * refreshed.hand.length)];
    const s2 = discardTile(s1, discardTileChoice.id);
    room.sendToAll((viewerId) => ({ type: 'state_sync', state: maskStateFor(s2, viewerId) }));
    room.sendToAll(() => ({ type: 'tile_discarded', tileId: discardTileChoice.id, nextPlayerId: s2.turn.activePlayerId }));
    room.sendToAll(() => ({ type: 'turn_started', activePlayerId: s2.turn.activePlayerId, timeLimitSeconds: s2.turn.timeLimitSeconds }));

    maybeRunBotTurns(room);
  }, 900);
}

function finishRound(room, winnerId) {
  const state = room.gameState;
  state.isRoundOver = true;
  const scores = {};
  for (const p of state.players) scores[p.id] = p.id === winnerId ? 100 : 0;
  room.sendToAll(() => ({ type: 'game_finished', winnerId, scores }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roomOf(playerId) {
  const conn = connections.get(playerId);
  if (!conn) return null;
  return roomManager.getRoom(conn.roomCode);
}

function broadcastWaitingUpdate(room) {
  const players = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, seat: p.seat }));
  room.sendToAll(() => ({ type: 'waiting_update', roomCode: room.code, seatedCount: room.seatedCount, maxSeats: 4, players }));
}

/** Hides every other player's actual tiles: same hand length, but placeholder face-down
 *  tiles, since the Android UI only ever reads opponents' hand.size (see GameSeatCard.kt). */
function maskStateFor(state, viewerId) {
  return {
    ...state,
    players: state.players.map((p) => {
      if (p.id === viewerId) {
        return { ...p, kind: 'HUMAN' };
      }
      return {
        ...p,
        kind: p.kind === 'AI' ? 'AI' : 'REMOTE',
        hand: p.hand.map(() => ({ id: -1, color: 'BLACK', value: 0, isFakeOkey: false, isRealOkey: false }))
      };
    })
  };
}

function newPlayerId() {
  return crypto.randomUUID();
}

function safeName(name) {
  const trimmed = String(name || '').trim().slice(0, 24);
  return trimmed || `Oyuncu${Math.floor(Math.random() * 9000 + 1000)}`;
}

function send(socket, message) {
  try {
    socket.send(JSON.stringify(message));
  } catch (err) {
    // ignore
  }
}

function sendError(socket, message) {
  send(socket, { type: 'error', message });
}

function sendErrorTo(playerId, message) {
  const conn = connections.get(playerId);
  if (conn) sendError(conn.socket, message);
}

httpServer.listen(PORT, () => {
  console.log(`OkeyMeta online server listening on port ${PORT}`);
});
