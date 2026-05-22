"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rooms = void 0;
exports.createRoom = createRoom;
const game_1 = require("./game");
const timer_1 = require("./timer");
const crypto_1 = __importDefault(require("crypto"));
exports.rooms = {};
function createRoom(code, players, columnsToWin) {
    const cw = clampColumns(columnsToWin ?? game_1.DEFAULT_COLUMNS_TO_WIN);
    exports.rooms[code] = {
        code,
        players: players.map(p => (0, game_1.createPlayer)(p)),
        currentPlayerIndex: Math.floor(Math.random() * players.length),
        phase: 'rolling',
        lockedColumns: [],
        activeMarkers: {},
        dice: [],
        splits: [],
        options: { columnsToWin: cw },
        winnerUserId: null,
        turnStartedAt: null,
        turnDuration: timer_1.TURN_DURATION,
        socketIds: new Map(),
        disconnectTimers: new Map(),
        currentGameId: crypto_1.default.randomUUID(),
    };
    return exports.rooms[code];
}
function clampColumns(v) {
    if (v < game_1.MIN_COLUMNS_TO_WIN)
        return game_1.MIN_COLUMNS_TO_WIN;
    if (v > game_1.MAX_COLUMNS_TO_WIN)
        return game_1.MAX_COLUMNS_TO_WIN;
    return Math.floor(v);
}
