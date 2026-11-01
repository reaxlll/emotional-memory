export { normalize, stateAt, shapeAt, bands, bandOf, DEFAULT_CONFIG } from "./affect.mjs";
export { compose, V_NAMES, A_NAMES } from "./state.mjs";
export { FACES, SHAPES, TRANSITIONS } from "./phrases.zh-CN.mjs";
export {
  openLibrary, append, byDate, recall, shape, key,
  recallSemantic, affectOf, pickAffectWord,
} from "./memory.mjs";
export {
  buildTree, hydrate, descend, promote, freeze, insert, cos,
} from "./tree.mjs";
export { loadAliases, matchAlias, appendAlias } from "./aliases.mjs";
