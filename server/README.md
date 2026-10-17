# OkeyMeta Online Server

Authoritative WebSocket server for OkeyMeta Game's online multiplayer. It is the single
source of truth for online hands: it shuffles the deck, deals, validates draws/discards
and win declarations, and pushes `GameState` snapshots down to every seated client —
exactly the architecture the Android client's `OkeySocketManager.kt` was already written
against.

**"Özel Oda" (private room) and "Online Çok Oyunculu" (quick match) are the same table
concept underneath.** A private room is just a table you reach by typing a 5-character
code instead of being auto-matched into one; both paths land you in the same `Room`
class, dealt from the same engine, on the same server.

## Running locally

```bash
cd server
npm install
npm start
# -> "OkeyMeta online server listening on port 8080"
```

Point the app at `ws://<your-machine-ip>:8080` while developing (see
`network_security_config.xml` — cleartext `ws://` is only meant for local testing;
production should use `wss://`, which Render provides automatically over HTTPS).

## Deploying to Render

1. Push this repo to GitHub.
2. In the Render dashboard: **New > Blueprint**, point it at the repo. Render will read
   `server/render.yaml` and provision a free Node web service automatically
   (`rootDir: server`, `npm install` / `npm start`).
   - Or manually: **New > Web Service**, root directory `server`, build command
     `npm install`, start command `npm start`, environment `Node`.
3. Once deployed, Render gives you a URL like `okeymeta-online-server.onrender.com`.
   Your WebSocket endpoint is `wss://okeymeta-online-server.onrender.com`.
4. Put that host into the app (see `OkeySocketManager.kt` — `DEFAULT_SERVER_URL`, or the
   in-app value if you wire it to Settings later).

Render's free tier spins the service down after inactivity; the first connection after
idle can take a few seconds to "wake up" — the client's `Reconnecting` state covers this.

## Wire protocol

Every message is a single JSON object with a `"type"` field. Field names mirror the
Kotlin `GameState`/`Player`/`Tile` model exactly, so the client deserializes the
`state_sync` payload directly into `@Serializable` data classes.

### Client → Server
| type | fields |
|---|---|
| `create_room` | `displayName` — creates a private room, returns a 5-char code |
| `join_room` | `roomCode`, `displayName` — joins an existing room by code |
| `quick_match` | `displayName` — auto-joins/opens a public table |
| `start_room` | — host forces an early start; empty seats are filled with AI |
| `draw_tile` | `fromDiscard` (bool) |
| `discard_tile` | `tileId` |
| `declare_win` | — server re-validates the hand before accepting |
| `chat` | `text` |
| `reconnect` | `roomCode`, `playerId` — resume a dropped connection within the grace window |
| `leave_room` | — |

### Server → Client
| type | fields |
|---|---|
| `room_created` | `roomCode`, `playerId`, `seat` |
| `player_joined` | `playerId`, `slot`, `displayName` |
| `player_left` | `playerId` |
| `waiting_update` | `roomCode`, `seatedCount`, `maxSeats`, `players[]` — lobby-only |
| `state_sync` | `state` — full `GameState`, opponents' tiles masked |
| `turn_started` | `activePlayerId`, `timeLimitSeconds` |
| `tile_drawn` | `fromDiscard` |
| `tile_discarded` | `tileId`, `nextPlayerId` |
| `chat_received` | `playerId`, `text` |
| `game_finished` | `winnerId`, `scores` (map of playerId → points) |
| `reconnecting` | a seated player's socket dropped; grace period started |
| `error` | `message` |

## What's intentionally simplified (v1)

- Win declarations are re-validated server-side with the same meld/pairs logic as the
  local engine, but there's no anti-cheat beyond that (no move-timing enforcement, no
  rate limiting). Fine for a first online release; harden before scaling up.
- Disconnected human seats get a 45s grace period to reconnect before the seat frees up;
  there's no persistent match history/reconnpayload beyond the live `GameState`.
- Bots filled in via "Erken Başlat" play a simple random-discard turn — good enough to
  keep an early-started table moving, not a strategic opponent (see `OkeyAiStrategy.kt`
  on the client for the real AI, used in offline modes).
