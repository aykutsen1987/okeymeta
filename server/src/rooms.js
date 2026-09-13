'use strict';

const { dealNewRound } = require('./engine');

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, matches PrivateRoomScreen.kt
const MAX_SEATS = 4;
const DISCONNECT_GRACE_MS = 45_000; // matches ConnectionStatus.RECONNECTING window before a seat opens back up

function generateRoomCode(existingCodes) {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (existingCodes.has(code));
  return code;
}

class Room {
  constructor(code, isPrivate) {
    this.code = code;
    this.isPrivate = isPrivate; // true = created via "Create Room" (private room / code join)
    this.players = new Map(); // playerId -> { id, name, seat, socket, connected, kind }
    this.gameState = null; // null until the hand starts
    this.disconnectTimers = new Map(); // playerId -> Timeout
  }

  get seatedCount() {
    return this.players.size;
  }

  isFull() {
    return this.seatedCount >= MAX_SEATS;
  }

  hasStarted() {
    return this.gameState !== null;
  }

  nextFreeSeat() {
    const taken = new Set([...this.players.values()].map((p) => p.seat));
    for (let seat = 0; seat < MAX_SEATS; seat++) {
      if (!taken.has(seat)) return seat;
    }
    return -1;
  }

  addPlayer(playerId, name, socket) {
    const seat = this.nextFreeSeat();
    const entry = { id: playerId, name, seat, socket, connected: true, kind: 'HUMAN' };
    this.players.set(playerId, entry);
    return entry;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    const timer = this.disconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(playerId);
    }
  }

  /** Fills any remaining empty seats with AI bots so a private/quick-match room isn't stuck
   *  waiting forever if the host chooses to start early. */
  fillRemainingWithBots() {
    const botNames = ['Ayşe (AI)', 'Mehmet (AI)', 'Zeynep (AI)'];
    let botIndex = 0;
    while (!this.isFull()) {
      const seat = this.nextFreeSeat();
      const botId = `bot-${this.code}-${seat}`;
      this.players.set(botId, {
        id: botId,
        name: botNames[botIndex++ % botNames.length],
        seat,
        socket: null,
        connected: true,
        kind: 'AI'
      });
    }
  }

  startHand() {
    const orderedPlayers = [...this.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind, seat: p.seat }));
    const mode = this.isPrivate ? 'PRIVATE_ROOM' : 'ONLINE_MULTIPLAYER';
    this.gameState = dealNewRound(orderedPlayers, `room-${this.code}`, mode, 0);
    return this.gameState;
  }

  startNextHand() {
    const prevState = this.gameState;
    const scoreById = new Map((prevState?.players || []).map((p) => [p.id, p.score || 0]));
    const prevRoundNumber = prevState?.roundNumber || 1;
    const prevDealerSeat = (prevState?.turn?.turnNumber !== undefined && prevState.players)
      ? (prevState.players.find((p) => p.hand && p.hand.length === 15)?.seat ?? 0)
      : 0;

    const orderedPlayers = [...this.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind, seat: p.seat, score: scoreById.get(p.id) || 0 }));

    const mode = this.isPrivate ? 'PRIVATE_ROOM' : 'ONLINE_MULTIPLAYER';
    const nextDealerSeat = (prevDealerSeat + 1) % orderedPlayers.length;
    this.gameState = dealNewRound(orderedPlayers, `room-${this.code}`, mode, nextDealerSeat);
    this.gameState.roundNumber = prevRoundNumber + 1;
    return this.gameState;
  }

  broadcast(exceptPlayerId, buildMessage) {
    for (const [playerId, entry] of this.players) {
      if (playerId === exceptPlayerId) continue;
      if (entry.socket && entry.connected) {
        sendSafe(entry.socket, buildMessage(playerId));
      }
    }
  }

  sendToAll(buildMessage) {
    this.broadcast(null, buildMessage);
  }
}

function sendSafe(socket, message) {
  try {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  } catch (err) {
    // Socket already closing/closed — ignore, disconnect handling will clean it up.
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
    this.quickMatchQueue = []; // rooms currently open to public quick-match joins
  }

  createPrivateRoom() {
    const code = generateRoomCode(this.rooms);
    const room = new Room(code, true);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  /** Quick match: joins an open public room with a free seat, or opens a new one. */
  findOrCreateQuickMatchRoom() {
    let room = this.quickMatchQueue.find((r) => !r.isFull() && !r.hasStarted());
    if (!room) {
      const code = generateRoomCode(this.rooms);
      room = new Room(code, false);
      this.rooms.set(code, room);
      this.quickMatchQueue.push(room);
    }
    return room;
  }

  removeFromQuickMatchQueue(room) {
    const idx = this.quickMatchQueue.indexOf(room);
    if (idx !== -1) this.quickMatchQueue.splice(idx, 1);
  }

  destroyRoomIfEmpty(room) {
    const anyHumanLeft = [...room.players.values()].some((p) => p.kind === 'HUMAN' && p.connected);
    if (!anyHumanLeft) {
      this.rooms.delete(room.code);
      this.removeFromQuickMatchQueue(room);
    }
  }
}

module.exports = { RoomManager, Room, MAX_SEATS, DISCONNECT_GRACE_MS };
