'use strict';

const { createFullDeck, determineIndicatorAndOkey, sortHand, TILE_COLORS } = require('./tiles');

/**
 * Deals a fresh hand for `players` (array of {id, name, kind, seat, ...}): 15 tiles to the
 * dealer (seat 0 by default), 14 to everyone else. Mirrors OkeyEngine#dealNewRound.
 * @returns {object} a GameState-shaped plain object.
 */
function dealNewRound(players, gameId, mode, dealerSeat = 0) {
  const deck = createFullDeck();
  const { indicator, okeyTile } = determineIndicatorAndOkey(deck);

  const dealtPlayers = players.map((player, index) => {
    const handSize = index === dealerSeat ? 15 : 14;
    const hand = deck.splice(0, handSize);
    return {
      ...player,
      hand: sortHand(hand, okeyTile),
      openedMelds: [],
      score: player.score || 0,
      hasOpened: false,
      connectionStatus: player.connectionStatus || 'CONNECTED',
      isCurrentTurn: false
    };
  });

  const firstTurnSeat = dealerSeat % players.length;
  const firstPlayer = dealtPlayers.find((p) => p.seat === firstTurnSeat);

  return {
    gameId,
    mode,
    players: dealtPlayers,
    deck: { drawPile: deck, discardPile: [], indicator, okeyTile },
    turn: { activePlayerId: firstPlayer.id, phase: 'AWAITING_DISCARD', turnNumber: 0, timeLimitSeconds: 20 },
    roundNumber: 1,
    isRoundOver: false,
    lastResult: null
  };
}

/** Draws the next tile for the active player from the closed pile. Mutates and returns state. */
function drawFromPile(state) {
  const { deck } = state;
  if (deck.drawPile.length === 0) {
    state.isRoundOver = true;
    state.turn.phase = 'ROUND_OVER';
    return state;
  }
  const tile = deck.drawPile.shift();
  const player = state.players.find((p) => p.id === state.turn.activePlayerId);
  if (player) player.hand.push(tile);
  state.turn.phase = 'AWAITING_DISCARD';
  return state;
}

/** Draws the top discard tile instead of the closed pile. */
function drawFromDiscard(state) {
  const { deck } = state;
  const tile = deck.discardPile.pop();
  if (!tile) return state;
  const player = state.players.find((p) => p.id === state.turn.activePlayerId);
  if (player) player.hand.push(tile);
  state.turn.phase = 'AWAITING_DISCARD';
  return state;
}

/** Discards `tileId` from the active player's hand and advances the turn to the next seat. */
function discardTile(state, tileId) {
  const active = state.players.find((p) => p.id === state.turn.activePlayerId);
  if (!active) return state;
  const tileIndex = active.hand.findIndex((t) => t.id === tileId);
  if (tileIndex === -1) return state;

  const [tile] = active.hand.splice(tileIndex, 1);
  state.deck.discardPile.push(tile);

  const nextSeat = (active.seat + 1) % state.players.length;
  const nextPlayer = state.players.find((p) => p.seat === nextSeat);

  state.turn = {
    activePlayerId: nextPlayer.id,
    phase: 'AWAITING_DRAW',
    turnNumber: state.turn.turnNumber + 1,
    timeLimitSeconds: 20
  };
  return state;
}

function tileIsWild(tile) {
  return tile.isFakeOkey || tile.isRealOkey;
}

/**
 * Validates whether `tiles` form a legal meld (per): a RUN (3+ same-color sequential
 * values, 13->1 wraps once) or a SET (3-4 tiles same value, distinct colors). Wild tiles
 * substitute freely. Mirrors OkeyEngine#isValidMeld.
 */
function isValidMeld(tiles) {
  if (tiles.length < 3) return false;
  const nonWild = tiles.filter((t) => !tileIsWild(t));
  if (nonWild.length === 0) return tiles.length >= 3 && tiles.length <= 4;

  const sameColor = new Set(nonWild.map((t) => t.color)).size === 1;
  if (sameColor && tiles.every((t) => tileIsWild(t) || t.color === nonWild[0].color)) {
    if (isSequentialRun(tiles)) return true;
  }

  if (tiles.length <= 4) {
    const values = new Set(nonWild.map((t) => t.value));
    const colorsDistinct = new Set(nonWild.map((t) => t.color)).size === nonWild.length;
    if (values.size === 1 && colorsDistinct) return true;
  }
  return false;
}

function isSequentialRun(tiles) {
  const wildCount = tiles.filter(tileIsWild).length;
  const fixedValues = tiles.filter((t) => !tileIsWild(t)).map((t) => t.value).sort((a, b) => a - b);
  if (new Set(fixedValues).size !== fixedValues.length) return false;
  if (fixedValues.length === 0) return true;

  let gapsNeeded = 0;
  for (let i = 0; i < fixedValues.length - 1; i++) {
    const diff = fixedValues[i + 1] - fixedValues[i];
    if (diff === 0) return false;
    if (diff > 1) {
      const wraps = fixedValues[i] === 13 && fixedValues[i + 1] === 1;
      gapsNeeded += wraps ? 0 : diff - 1;
    }
  }
  return gapsNeeded <= wildCount;
}

function combinations(list, k) {
  if (k === 0) return [[]];
  if (list.length === 0) return [];
  const [head, ...tail] = list;
  const withHead = combinations(tail, k - 1).map((c) => [head, ...c]);
  const withoutHead = combinations(tail, k);
  return [...withHead, ...withoutHead];
}

function removeAll(list, toRemove) {
  const result = [...list];
  for (const tile of toRemove) {
    const idx = result.indexOf(tile);
    if (idx !== -1) result.splice(idx, 1);
  }
  return result;
}

/** Recursive partition search — small because it only ever runs on a 14-tile hand. */
function canPartitionIntoMelds(remaining) {
  if (remaining.length === 0) return true;
  if (remaining.length < 3) return false;

  for (const size of [3, 4]) {
    if (remaining.length < size) continue;
    const rest = remaining.slice(1);
    const candidates = combinations(rest, size - 1).map((c) => [remaining[0], ...c]);
    for (const group of candidates) {
      if (isValidMeld(group)) {
        const leftover = removeAll(remaining, group);
        if (canPartitionIntoMelds(leftover)) return true;
      }
    }
  }
  return false;
}

/** Checks whether `hand` (14 tiles) is a complete winning hand of melds. */
function isWinningHand(hand) {
  if (hand.length !== 14) return false;
  return canPartitionIntoMelds(hand);
}

/** Checks the alternative "pairs hand" (çift el) win: 7 identical pairs (14 tiles). */
function isPairsWinningHand(hand) {
  if (hand.length !== 14) return false;
  const used = new Array(hand.length).fill(false);
  let pairs = 0;
  for (let i = 0; i < hand.length; i++) {
    if (used[i]) continue;
    for (let j = i + 1; j < hand.length; j++) {
      if (used[j]) continue;
      const a = hand[i];
      const b = hand[j];
      const matches = tileIsWild(a) || tileIsWild(b) || (a.color === b.color && a.value === b.value);
      if (matches) {
        used[i] = true;
        used[j] = true;
        pairs++;
        break;
      }
    }
  }
  return pairs === 7;
}

function checkWin(hand) {
  return isWinningHand(hand) || isPairsWinningHand(hand);
}

module.exports = {
  dealNewRound,
  drawFromPile,
  drawFromDiscard,
  discardTile,
  isValidMeld,
  isWinningHand,
  isPairsWinningHand,
  checkWin,
  TILE_COLORS
};
