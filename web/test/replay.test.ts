// A recorded attempt replays exactly: same path, same touches, same parking result.
import { describe, expect, it } from 'vitest';
import { Recorder, STEP, playback, replayTo, stateOf } from '../src/core/replay';
import { Sim, type SimEvent } from '../src/core/sim';

/** Drive like a player would: pedals, a dragged wheel, Straighten, a touch on the way. */
function drive(sim: Sim, rec: Recorder): SimEvent[] {
  const events: SimEvent[] = [];
  const steps = (n: number, between?: (i: number) => void) => {
    for (let i = 0; i < n; i++) { between?.(i); rec.before(sim); events.push(...sim.step(STEP)); rec.after(sim); }
  };
  sim.input.fwd = true; steps(150);
  sim.input.wheelHeld = true; steps(40, i => { sim.wheelAngle = Math.max(-486, sim.wheelAngle - 12 - (i % 3)); });
  sim.input.wheelHeld = false; steps(200);
  sim.input.fwd = false; steps(60);
  sim.wheelTarget = 0; steps(30);
  sim.input.rev = true; sim.input.kr = true; steps(90); sim.input.kr = false; steps(60);
  sim.input.rev = false; steps(40);
  return events;
}

describe('replay', () => {
  const sim = new Sim(), rec = new Recorder();
  sim.reset('left'); rec.begin(sim);
  const live = drive(sim, rec);
  const { sim: again, step } = playback(rec.rec!, sim.scene, sim.vehicle);
  const replayed: SimEvent[] = []; for (let evs = step(); evs; evs = step()) replayed.push(...evs);

  it('records only what changed', () => { expect(rec.rec!.steps).toBe(670); expect(rec.rec!.events.length).toBeLessThan(80); });
  it('ends in exactly the same state', () => {
    for (const k of ['x', 'z', 'th', 'v', 'wheelAngle', 'hits', 'elapsed', 'time', 'parked'] as const) expect(Object.is(again[k], sim[k]), k).toBe(true);
    expect(again.sensorReadings).toEqual(sim.sensorReadings);
  });
  it('produces the same events', () => expect(replayed).toEqual(live));
  it('rewinds from its checkpoints to exactly where replaying it all would', () => {
    // a longer drive in the garage: past two checkpoints (every 10 s)
    const g = new Sim(), r = new Recorder(); g.reset('left'); r.begin(g);
    drive(g, r); drive(g, r);
    expect(r.rec!.marks!.map(m => m.step)).toEqual([600, 1200]);
    for (const n of [599, 600, 601, 1000, 1339]) {
      const all = replayTo(r.rec!, g.scene, g.vehicle, n, () => {});   // a hook: replayed from the start
      expect(JSON.stringify(stateOf(replayTo(r.rec!, g.scene, g.vehicle, n))), `step ${n}`).toBe(JSON.stringify(stateOf(all)));
    }
  });
  it('survives a round trip through JSON', () => {
    const copy = JSON.parse(JSON.stringify(rec.rec));
    const p = playback(copy, sim.scene, sim.vehicle); while (p.step());
    expect([p.sim.x, p.sim.z, p.sim.th]).toEqual([sim.x, sim.z, sim.th]);
  });
});
