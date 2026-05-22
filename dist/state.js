"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildStateFor = buildStateFor;
exports.emitState = emitState;
const game_1 = require("./game");
function buildStateFor(room, viewerId) {
    const current = room.players[room.currentPlayerIndex];
    return {
        code: room.code,
        phase: room.phase,
        currentPlayerIndex: room.currentPlayerIndex,
        currentUserId: current?.userId ?? null,
        lockedColumns: room.lockedColumns,
        activeMarkers: room.activeMarkers,
        dice: room.dice,
        splits: room.splits,
        options: room.options,
        winnerUserId: room.winnerUserId,
        turnStartedAt: room.turnStartedAt,
        turnDuration: room.turnDuration,
        columnLengths: game_1.COLUMN_LENGTHS,
        players: room.players.map(p => ({
            userId: p.userId,
            username: p.username,
            claimed: p.claimed,
            permanent: p.permanent,
            alive: p.alive,
            abandon: p.abandon ?? false,
            afk: p.afk ?? false,
        })),
        spectator: viewerId ? !room.players.some(p => p.userId === viewerId) : true,
    };
}
function emitState(io, room) {
    const sockets = io.sockets.adapter.rooms.get(room.code);
    if (!sockets)
        return;
    for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (!s)
            continue;
        const viewerId = s.data?.userId ?? null;
        s.emit('cant_stop:state', buildStateFor(room, viewerId));
    }
}
