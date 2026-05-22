import type { Server } from 'socket.io';
import { CantStopRoom } from './types';
import { COLUMN_LENGTHS } from './game';

export function buildStateFor(room: CantStopRoom, viewerId: string | null) {
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
        columnLengths: COLUMN_LENGTHS,
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

export function emitState(io: Server, room: CantStopRoom): void {
    const sockets = io.sockets.adapter.rooms.get(room.code);
    if (!sockets) return;
    for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (!s) continue;
        const viewerId = (s.data?.userId as string | undefined) ?? null;
        s.emit('cant_stop:state', buildStateFor(room, viewerId));
    }
}
