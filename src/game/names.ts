import type { Rng } from './rng';

const F_START = ['A', 'E', 'I', 'Ma', 'Na', 'Sa', 'Ta', 'Li', 'Ri', 'Ka', 'Yo', 'Ze', 'Ola', 'Mi', 'Su', 'Ve', 'Tho', 'Ae', 'Bri', 'Ny'];
const F_MID = ['la', 'ri', 'na', 'sh', 'ly', 've', 'mi', 'ra', 'el', 'in', 'ys', 'th', ''];
const F_END = ['a', 'ia', 'e', 'yn', 'ra', 'ah', 'ie', 'is', 'el', 'wen', 'ka', 'ny'];

const M_START = ['Bo', 'Da', 'Gor', 'Ha', 'Jo', 'Ko', 'Lu', 'Mo', 'Or', 'Ru', 'Tor', 'Ul', 'Var', 'Bran', 'Ed', 'Fen', 'Kai', 'Ren', 'Tam', 'Wy'];
const M_MID = ['ra', 'an', 'ro', 'gu', 'el', 'ma', 'ri', 'th', 'ok', 'da', ''];
const M_END = ['n', 'k', 'r', 'th', 'm', 'o', 'us', 'an', 'ek', 'ar', 'is', 'ul'];

export function settlerName(rng: Rng, female: boolean): string {
  const parts = female ? [F_START, F_MID, F_END] : [M_START, M_MID, M_END];
  let n = rng.pick(parts[0]) + rng.pick(parts[1]) + rng.pick(parts[2]);
  if (n.length > 9) n = n.slice(0, 9);
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

const PLACE_A = ['Ash', 'Ember', 'Stone', 'Elder', 'Wolf', 'Raven', 'Oak', 'Hearth', 'Mist', 'Amber', 'Thorn', 'Sun', 'Frost', 'Willow', 'Bright'];
const PLACE_B = ['ford', 'vale', 'hollow', 'stead', 'mere', 'brook', 'reach', 'haven', 'wick', 'field', 'crest', 'moor'];

export function placeName(rng: Rng): string {
  return rng.pick(PLACE_A) + rng.pick(PLACE_B);
}
