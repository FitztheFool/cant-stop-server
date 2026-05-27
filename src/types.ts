import type { GameLogEntry } from '@kwizar/shared';

export interface CantStopPlayer {
    userId: string;
    username: string;
    /** Columns claimed (won). Numbers 2..12. */
    claimed: number[];
    /** Banked progression per column (only for non-claimed cols). */
    permanent: Record<number, number>;
    alive: boolean;
    abandon?: boolean;
    afk?: boolean;
}

export type Phase = 'rolling' | 'choosing' | 'busted' | 'ended';

export interface Split {
    /** Two pairs of dice indices [a,b] | [c,d]. */
    pairs: [[number, number], [number, number]];
    sums: [number, number];
    /** Whether picking this split lets the player advance at least one marker. */
    legal: boolean;
    /** Reason if not fully usable (e.g. only one sum playable). */
    partial?: boolean;
}

export interface CantStopRoom {
    code: string;
    players: CantStopPlayer[];
    currentPlayerIndex: number;
    phase: Phase;

    /** Columns claimed by anyone (no longer playable). */
    lockedColumns: number[];

    /** Active markers this turn: col -> position. Max 3 entries. */
    activeMarkers: Record<number, number>;

    /** Dice last rolled (4 values). */
    dice: number[];
    /** Pre-computed split options for the current dice. */
    splits: Split[];

    options: { columnsToWin: number };

    winnerUserId: string | null;
    turnStartedAt: number | null;
    turnDuration: number;

    socketIds: Map<string, string>;
    disconnectTimers: Map<string, ReturnType<typeof setTimeout>>;

    currentGameId: string;
    log: GameLogEntry[];
    logSeq?: number;
}

export interface ConfiguredPlayer {
    userId?: string;
    id?: string;
    username?: string;
    name?: string;
}

export interface CantStopOptions {
    columnsToWin?: number; // 2..4
}
