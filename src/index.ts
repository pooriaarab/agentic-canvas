export { VERSION } from "./version.js";
export { BRAND } from "./brand.js";
export { Board, CanvasError, MAX_ELEMENTS, MAX_TEXT, SHAPE_TYPES } from "./core/board.js";
export type {
  CanvasElement,
  Connector,
  Endpoint,
  ErrorCode,
  Group,
  Shape,
  ShapeType,
} from "./core/board.js";
export { PRINCIPAL_KINDS, isMachineMade, principalSchema } from "./core/principal.js";
export type { Principal, PrincipalKind } from "./core/principal.js";
