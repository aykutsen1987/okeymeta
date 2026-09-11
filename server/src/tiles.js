'use strict';

/**
 * Mirrors com.okeymeta.game.game.model.Tile / TileColor / Deck exactly (field names and
 * enum string values), so the JSON this server sends can be fed straight into the
 * Android app's kotlinx.serialization data classes without any translation layer.
 */

const TILE_COLORS = ['RED', 'YELLOW', 'BLUE', 'BLACK'];

/** @returns {object} a Tile-shaped plain object. */
function makeTile(id, color, value, isFakeOkey = false, isRealOkey = false) {
  return { id, color, value, isFakeOkey, isRealOkey };
}

/** Builds the standard 106-tile Okey set: 2x(4 colors x 1..13) + 2 fake-Okey tiles. */
function createFullDeck() {
  const deck = [];
  let idCounter = 1;
  for (let copy = 0; copy < 2; copy++) {
    for (const color of TILE_COLORS) {
      for (let v = 1; v <= 13; v++) {
        deck.push(makeTile(idCounter++, color, v));
      }
    }
  }
  for (let i = 0; i < 2; i++) {
    deck.push(makeTile(idCounter++, 'BLACK', 0, true, false));
  }
  shuffle(deck);
  return deck;
}

/** Fisher-Yates shuffle, in place. */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Pulls the gösterge (indicator) and derives the real Okey tile (one value above it, 13->1 wraps). */
function determineIndicatorAndOkey(deck) {
  const indicator = deck.shift();
  const okeyValue = indicator.value === 13 ? 1 : indicator.value + 1;
  const okeyTile = { ...indicator, value: okeyValue, isRealOkey: true };
  return { indicator, okeyTile };
}

function isWild(tile, okeyTile) {
  return tile.isFakeOkey || (tile.color === okeyTile.color && tile.value === okeyTile.value && !tile.isFakeOkey) || tile.isRealOkey;
}

/** Sorts a hand by color then value, wild tiles pinned to the end (matches OkeyEngine.sortHand). */
function sortHand(hand, okeyTile) {
  const wilds = hand.filter((t) => t.isFakeOkey || (t.color === okeyTile.color && t.value === okeyTile.value));
  const normal = hand.filter((t) => !wilds.includes(t));
  const colorOrder = (c) => TILE_COLORS.indexOf(c);
  normal.sort((a, b) => colorOrder(a.color) - colorOrder(b.color) || a.value - b.value);
  return [...normal, ...wilds];
}

module.exports = { TILE_COLORS, makeTile, createFullDeck, shuffle, determineIndicatorAndOkey, isWild, sortHand };
