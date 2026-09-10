// `seq` in both calls is the number the next round will take, so a rest ends STUCK_COOLDOWN
// rounds after the one that scheduled it.

import {PROBES, STUCK_AFTER, STUCK_COOLDOWN} from './probe.js';

// The failures a fresh connection can fix. A stalled read is a congested cell: resting the
// download for six rounds would blank the throughput exactly while the congestion runs.
const WEDGE_FAILS = new Set(['timeout', 'network']);

export function createStuckTracker({onNotice} = {}) {
  const consecutiveFails = {};
  const restingUntil = {};

  // Marks the row's stuck probes and schedules their rests. A probe is only stood down while
  // most of the others answer: below that threshold the network is down, and resting on it
  // would stand every probe down at once.
  function note(row, seq) {
    const healthy = PROBES.filter(p => row.probes[p.id]?.ok).length;
    const isolated = healthy > PROBES.length / 2;
    for (const p of PROBES) {
      const r = row.probes[p.id];
      if (!r || r.fail === 'resting') continue;
      if (r.ok) { consecutiveFails[p.id] = 0; delete restingUntil[p.id]; continue; }
      if (r.expected || r.blocked || r.unused) continue;
      if (!WEDGE_FAILS.has(r.fail)) { consecutiveFails[p.id] = 0; continue; }
      const n = consecutiveFails[p.id] = (consecutiveFails[p.id] || 0) + 1;
      if (isolated && n >= STUCK_AFTER && restingUntil[p.id] == null) {
        r.stuck = true;
        restingUntil[p.id] = seq + STUCK_COOLDOWN;
        consecutiveFails[p.id] = 0;
        onNotice?.(`${p.id} has failed ${n} rounds while the others answer; ` +
                   `resting it for ${STUCK_COOLDOWN} rounds to clear the connection.`);
      }
    }
  }

  // The probes to skip in the round about to run. Expired rests are dropped as they are read.
  function resting(seq) {
    const out = new Set();
    for (const [id, until] of Object.entries(restingUntil)) {
      if (seq < until) out.add(id);
      else delete restingUntil[id];
    }
    return out;
  }

  // One tracker lives for the page. A rest is scheduled by round number, so one left from a
  // previous session would silence a probe through the whole of the next.
  function reset() {
    for (const k of Object.keys(consecutiveFails)) delete consecutiveFails[k];
    for (const k of Object.keys(restingUntil)) delete restingUntil[k];
  }

  return {note, resting, reset};
}
