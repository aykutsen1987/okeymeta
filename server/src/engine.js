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
  // Flag the physical Okey tiles: only the detached okeyTile copy carried isRealOkey before, so the
  // joker never acted as a wild in isWinningHand / isPairsWinningHand.
  for (let i = 0; i < deck.length; i++) {
    const t = deck[i];
    if (!t.isFakeOkey && t.color === okeyTile.color && t.value === okeyTile.value) {
      deck[i] = { ...t, isRealOkey: true };
    }
  }

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
  if (tiles.length > 13) return false;
  const wildCount = tiles.filter(tileIsWild).length;
  const fixed = tiles.filter((t) => !tileIsWild(t)).map((t) => t.value);
  if (new Set(fixed).size !== fixed.length) return false;
  if (fixed.length === 0) return true;

  // 1 may be low (1-2-3) or high (12-13-1), but a run never wraps through the middle (13-1-2).
  const fits = (values) => {
    const sorted = [...values].sort((x, y) => x - y);
    let gaps = 0;
    for (let i = 0; i < sorted.length - 1; i++) gaps += sorted[i + 1] - sorted[i] - 1;
    return gaps <= wildCount;
  };
  return fits(fixed) || fits(fixed.map((v) => (v === 1 ? 14 : v)));
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

/**
 * Recursive partition search. The first tile must belong to some meld of 3..13 tiles (sets are
 * capped at 4 inside isValidMeld, runs can be longer), and only tiles that could share a meld with
 * it (same color for a run, same value for a set, or a wild) are tried as partners.
 */
function canPartitionIntoMelds(remaining) {
  if (remaining.length === 0) return true;
  if (remaining.length < 3) return false;

  const ordered = [...remaining].sort((x, y) => Number(tileIsWild(x)) - Number(tileIsWild(y)));
  const first = ordered[0];
  const rest = ordered.slice(1);
  const runPool = tileIsWild(first) ? rest : rest.filter((t) => tileIsWild(t) || t.color === first.color);
  const setPool = tileIsWild(first) ? rest : rest.filter((t) => tileIsWild(t) || t.value === first.value);

  const tryGroups = (pool, maxSize) => {
    for (let size = 3; size <= maxSize; size++) {
      if (size - 1 > pool.length) break;
      const leftoverSize = ordered.length - size;
      if (leftoverSize === 1 || leftoverSize === 2) continue;
      for (const combo of combinations(pool, size - 1)) {
        const group = [first, ...combo];
        if (!isValidMeld(group)) continue;
        if (canPartitionIntoMelds(removeAll(ordered, group))) return true;
      }
    }
    return false;
  };

  return tryGroups(runPool, Math.min(ordered.length, 13)) || tryGroups(setPool, Math.min(ordered.length, 4));
}

/** Checks whether `hand` (14 tiles) is a complete winning hand of melds. */
function isWinningHand(hand) {
  if (hand.length !== 14) return false;
  return canPartitionIntoMelds(hand);
}

/**
 * Checks the alternative "pairs hand" win: 7 identical pairs (14 tiles). Wilds are only assigned
 * AFTER natural pairs are counted: each unpaired tile needs one wild, leftover wilds pair up.
 */
function isPairsWinningHand(hand) {
  if (hand.length !== 14) return false;
  const wilds = hand.filter(tileIsWild).length;
  const counts = new Map();
  for (const t of hand) {
    if (tileIsWild(t)) continue;
    const key = `${t.color}:${t.value}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let singles = 0;
  for (const c of counts.values()) singles += c % 2;
  return singles <= wilds && (wilds - singles) % 2 === 0;
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
