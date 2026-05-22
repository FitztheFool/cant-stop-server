"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveCantStopResults = saveCantStopResults;
const shared_1 = require("@kwizar/shared");
const game_1 = require("./game");
function saveCantStopResults(room, winnerUserId, gameId) {
    const vsBot = room.players.some(p => (0, game_1.isBot)(p.userId));
    const scores = room.players.map(p => {
        const isWinner = winnerUserId === p.userId;
        return {
            userId: p.userId,
            username: p.username,
            score: isWinner ? 1 : 0,
            placement: isWinner ? 1 : (p.abandon || p.afk ? null : (p.alive ? 2 : null)),
            abandon: p.abandon ?? false,
            afk: p.afk ?? false,
        };
    });
    (0, shared_1.saveAttempts)('CANT_STOP', gameId, scores, vsBot);
}
