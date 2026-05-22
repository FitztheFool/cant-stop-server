import { CantStopRoom, CantStopPlayer } from './types';
import { COLUMN_LENGTHS, MAX_ACTIVE_MARKERS } from './game';

/** Pick best split for the bot. Returns index 0-2. */
export function botPickSplit(room: CantStopRoom): number {
    // Prefer legal splits. Among legal, prefer those that avoid creating a new marker
    // when 3 markers already exist, and that target columns near the center (more likely to advance again).
    const legalIndices = room.splits.map((s, i) => ({ s, i })).filter(x => x.s.legal);
    if (legalIndices.length === 0) return 0;
    legalIndices.sort((a, b) => {
        // Penalize splits where a sum would require a brand-new column when 3 markers active.
        const aPenalty = needsNewMarkerPenalty(a.s.sums, room);
        const bPenalty = needsNewMarkerPenalty(b.s.sums, room);
        if (aPenalty !== bPenalty) return aPenalty - bPenalty;
        const aCenter = centerScore(a.s.sums);
        const bCenter = centerScore(b.s.sums);
        return bCenter - aCenter;
    });
    return legalIndices[0].i;
}

function needsNewMarkerPenalty(sums: [number, number], room: CantStopRoom): number {
    const active = Object.keys(room.activeMarkers).length;
    if (active < MAX_ACTIVE_MARKERS) return 0;
    let pen = 0;
    for (const s of sums) {
        if (!(s in room.activeMarkers)) pen++;
    }
    return pen;
}

function centerScore(sums: [number, number]): number {
    // Center sums (7) are more probable; bot prefers them.
    return sums.reduce((acc, s) => acc + (13 - Math.abs(s - 7)), 0);
}

/** Decide whether bot stops banking or keeps rolling. */
export function botShouldStop(room: CantStopRoom, player: CantStopPlayer): boolean {
    const active = Object.keys(room.activeMarkers);
    // No active markers banked yet → keep going.
    if (active.length === 0) return false;

    // Always stop if at least one column would be claimed next stop and player needs the column.
    for (const colStr of active) {
        const col = Number(colStr);
        if (room.activeMarkers[col] >= COLUMN_LENGTHS[col]) return true;
    }

    // If 3 markers actively progressing — more conservative.
    const totalAdvance = active.reduce((acc, colStr) => {
        const col = Number(colStr);
        const start = player.permanent[col] ?? 0;
        return acc + (room.activeMarkers[col] - start);
    }, 0);

    if (active.length === MAX_ACTIVE_MARKERS) {
        if (totalAdvance >= 4) return true;
        return Math.random() < 0.55;
    }
    if (active.length === 2) {
        if (totalAdvance >= 5) return true;
        return Math.random() < 0.30;
    }
    // 1 active marker
    if (totalAdvance >= 6) return true;
    return Math.random() < 0.10;
}
