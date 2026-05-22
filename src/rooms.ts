import { CantStopRoom, ConfiguredPlayer } from './types';
import { createPlayer, DEFAULT_COLUMNS_TO_WIN, MIN_COLUMNS_TO_WIN, MAX_COLUMNS_TO_WIN } from './game';
import { TURN_DURATION } from './timer';
import crypto from 'crypto';

export const rooms: Record<string, CantStopRoom> = {};

export function createRoom(code: string, players: ConfiguredPlayer[], columnsToWin?: number): CantStopRoom {
    const cw = clampColumns(columnsToWin ?? DEFAULT_COLUMNS_TO_WIN);
    rooms[code] = {
        code,
        players: players.map(p => createPlayer(p)),
        currentPlayerIndex: Math.floor(Math.random() * players.length),
        phase: 'rolling',
        lockedColumns: [],
        activeMarkers: {},
        dice: [],
        splits: [],
        options: { columnsToWin: cw },
        winnerUserId: null,
        turnStartedAt: null,
        turnDuration: TURN_DURATION,
        socketIds: new Map(),
        disconnectTimers: new Map(),
        currentGameId: crypto.randomUUID(),
    };
    return rooms[code];
}

function clampColumns(v: number): number {
    if (v < MIN_COLUMNS_TO_WIN) return MIN_COLUMNS_TO_WIN;
    if (v > MAX_COLUMNS_TO_WIN) return MAX_COLUMNS_TO_WIN;
    return Math.floor(v);
}
