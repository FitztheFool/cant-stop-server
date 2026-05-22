import { CantStopPlayer, CantStopRoom, ConfiguredPlayer, Split } from './types';

// Column lengths (number of cells before claim).
// Pattern follows the bell curve of two-dice sums.
export const COLUMN_LENGTHS: Record<number, number> = {
    2: 3, 3: 5, 4: 7, 5: 9, 6: 11, 7: 13,
    8: 11, 9: 9, 10: 7, 11: 5, 12: 3,
};

export const COLUMNS = Object.keys(COLUMN_LENGTHS).map(Number);
export const MAX_ACTIVE_MARKERS = 3;
export const DEFAULT_COLUMNS_TO_WIN = 3;
export const MIN_COLUMNS_TO_WIN = 2;
export const MAX_COLUMNS_TO_WIN = 4;

export function isBot(userId: string): boolean {
    return userId.startsWith('bot-');
}

export function createPlayer(p: ConfiguredPlayer): CantStopPlayer {
    return {
        userId: (p.userId ?? p.id) as string,
        username: (p.username ?? p.name) as string,
        claimed: [],
        permanent: {},
        alive: true,
    };
}

export function rollDice(): number[] {
    return [
        1 + Math.floor(Math.random() * 6),
        1 + Math.floor(Math.random() * 6),
        1 + Math.floor(Math.random() * 6),
        1 + Math.floor(Math.random() * 6),
    ];
}

/**
 * Returns the three possible pairings of 4 dice into 2 pairs.
 * Indices fixed: (0+1, 2+3), (0+2, 1+3), (0+3, 1+2).
 */
export function computeSplits(dice: number[], room: CantStopRoom, player: CantStopPlayer): Split[] {
    const pairings: Array<[[number, number], [number, number]]> = [
        [[0, 1], [2, 3]],
        [[0, 2], [1, 3]],
        [[0, 3], [1, 2]],
    ];

    return pairings.map(pairs => {
        const sums: [number, number] = [dice[pairs[0][0]] + dice[pairs[0][1]], dice[pairs[1][0]] + dice[pairs[1][1]]];
        const { legal, partial } = isSplitPlayable(sums, room, player);
        return { pairs, sums, legal, partial };
    });
}

/**
 * Check if a split lets the player advance at least one of its two sums.
 * Picking a split when only one sum is playable still counts as legal (partial=true).
 */
export function isSplitPlayable(sums: [number, number], room: CantStopRoom, player: CantStopPlayer): { legal: boolean; partial: boolean } {
    const sim = simulateAdvance(sums, room, player);
    return { legal: sim.advanced > 0, partial: sim.advanced === 1 && sums[0] !== sums[1] ? true : (sim.partial ?? false) };
}

interface SimResult {
    advanced: number;
    newActive: Record<number, number>;
    partial?: boolean;
}

/**
 * Try to advance markers for both sums in order. Returns updated activeMarkers state and how many sums were applied.
 * Rules:
 * - Skip sums on locked columns.
 * - If active marker exists on col -> increment position (if not at top).
 * - Else if room.activeMarkers has < 3 entries (counting newly-added ones too) -> add new marker at position = (permanent[col] || 0) + 1.
 * - Else (3 active markers and col not among them) -> sum is unplayable.
 * - If two sums equal: handle as single column advance twice.
 */
export function simulateAdvance(sums: [number, number], room: CantStopRoom, player: CantStopPlayer): SimResult {
    const active = { ...room.activeMarkers };
    let advanced = 0;

    const tryAdvance = (sum: number): boolean => {
        if (!COLUMN_LENGTHS[sum]) return false;
        if (room.lockedColumns.includes(sum)) return false;
        // Don't allow advancing a column the player already claimed.
        if (player.claimed.includes(sum)) return false;

        const top = COLUMN_LENGTHS[sum];
        const current = active[sum] ?? null;

        if (current !== null) {
            if (current >= top) return false;
            active[sum] = current + 1;
            return true;
        }
        // New marker — must have a slot.
        const occupied = Object.keys(active).length;
        if (occupied >= MAX_ACTIVE_MARKERS) return false;
        const start = player.permanent[sum] ?? 0;
        if (start >= top) return false;
        active[sum] = start + 1;
        return true;
    };

    const ok0 = tryAdvance(sums[0]);
    if (ok0) advanced++;
    const ok1 = tryAdvance(sums[1]);
    if (ok1) advanced++;

    return { advanced, newActive: active, partial: (ok0 !== ok1) && advanced === 1 };
}

/** Apply a split to the room's active markers in place. Returns claimed cols this push (if marker reached top). */
export function applySplit(split: Split, room: CantStopRoom, player: CantStopPlayer): { claimedNow: number[] } {
    const sim = simulateAdvance(split.sums, room, player);
    room.activeMarkers = sim.newActive;
    // Detect cols where active marker reached top -> immediately claim & lock.
    const claimedNow: number[] = [];
    for (const colStr of Object.keys(room.activeMarkers)) {
        const col = Number(colStr);
        const pos = room.activeMarkers[col];
        if (pos >= COLUMN_LENGTHS[col]) {
            claimedNow.push(col);
        }
    }
    if (claimedNow.length > 0) {
        for (const col of claimedNow) {
            if (!player.claimed.includes(col)) player.claimed.push(col);
            if (!room.lockedColumns.includes(col)) room.lockedColumns.push(col);
            delete room.activeMarkers[col];
            delete player.permanent[col];
        }
    }
    return { claimedNow };
}

/** Save active markers into the player's permanent progress. Clears activeMarkers. */
export function bankMarkers(room: CantStopRoom, player: CantStopPlayer): void {
    for (const colStr of Object.keys(room.activeMarkers)) {
        const col = Number(colStr);
        const pos = room.activeMarkers[col];
        // Don't overwrite if claimed (shouldn't happen since applySplit already strips them).
        if (room.lockedColumns.includes(col)) continue;
        player.permanent[col] = pos;
    }
    room.activeMarkers = {};
}

/** Check if any split with the current dice is playable. */
export function hasLegalSplit(room: CantStopRoom, player: CantStopPlayer): boolean {
    return room.splits.some(s => s.legal);
}

/** Move to next alive non-claimed player and reset turn state. */
export function nextTurn(room: CantStopRoom): void {
    room.activeMarkers = {};
    room.dice = [];
    room.splits = [];
    room.phase = 'rolling';
    const total = room.players.length;
    for (let i = 1; i <= total; i++) {
        const idx = (room.currentPlayerIndex + i) % total;
        if (room.players[idx].alive) {
            room.currentPlayerIndex = idx;
            return;
        }
    }
}

export function checkVictory(room: CantStopRoom, player: CantStopPlayer): boolean {
    return player.claimed.length >= room.options.columnsToWin;
}
