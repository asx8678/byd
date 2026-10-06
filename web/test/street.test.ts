// The street lessons (core/streetLesson.ts): each finds its way and a space for every car on either side of the road,
// the coach says what is coming at each junction, careful drivers pass in the lesson's own traffic, and one who never
// signals or waits too long beside the space does not. STREET_ALL=1 drives every car (slow); otherwise a few.
import { describe, expect, it } from 'vitest';
import { VEHICLES } from '../src/core/content';
import { COURSE, lessonFor } from '../src/core/lesson';
import { STREET_DRIVERS, STREET_FAILERS, streetDrive } from '../src/core/robot';
import { StreetCoach, checkStreetPass, loadStreetLesson, wayWords, type StreetEvent } from '../src/core/streetLesson';
import { Traffic } from '../src/core/traffic';

const LESSONS = COURSE.lessons.filter(l => l.street);
const CARS = ['byd-atto2', 'smart-fortwo-c453', 'peugeot-208-p21', 'skoda-octavia-combi-nx', 'ram-1500-dt', 'mercedes-s-class-w223@10', 'mercedes-s-class-w223@4.5', 'mercedes-s-class-w223@0'];
const ALL = !!process.env.STREET_ALL;
const DRIVEN: [string, 'right' | 'left'][] = ALL ? CARS.flatMap(id => [[id, 'right'], [id, 'left']] as [string, 'right' | 'left'][]) : [['byd-atto2', 'right'], ['byd-atto2', 'left'], ['ram-1500-dt', 'right'], ['smart-fortwo-c453', 'right']];
const load = (id: string, lesson: string, drive: 'right' | 'left') => loadStreetLesson(VEHICLES[id], COURSE.lessons.find(l => l.id === lesson)!, drive);

describe('street lessons', () => {
  it('are two, in their own chapter, for every car', () => {
    expect(LESSONS.map(l => [l.n, l.id])).toEqual([[14, 'street-traffic'], [15, 'street-leavers']]);
    expect(LESSONS[0].chapter).toBe('On the street');
    for (const id of CARS) for (const l of LESSONS) expect(lessonFor(VEHICLES[id], l)).toBe(true);
  });
  it('find their way and a space for every car, on either side of the road', () => {
    for (const l of LESSONS) for (const drive of ['right', 'left'] as const) for (const id of CARS) {
      const L = load(id, l.id, drive);
      expect(L, `${l.id} ${id} ${drive}`).not.toBeNull();
      expect(L!.slot.side, `${l.id} ${id} ${drive}: the kerb on the side traffic keeps to`).toBe(L!.net.els[L!.way[L!.way.length - 1]].side);
      if (l.street!.space === 'leaver') { expect(L!.extras.leaveAt?.slot).toBe(L!.slot.id); expect(L!.extras.thiefAt).toBeDefined(); }
    }
    expect(wayWords(load('byd-atto2', 'street-traffic', 'right')!, 'right')).toBe('Left at the lights into Market Street, then right at the give-way line into Ropewalk, then park in the space on your right.');
    expect(wayWords(load('byd-atto2', 'street-leavers', 'right')!, 'right')).toBe('Straight on at the lights, then park in the space on your right.');
  }, 60000);
  it('bring their own leaver and thief, the same every time (with or without Pro: the traffic setting has no say)', () => {
    const L = load('byd-atto2', 'street-leavers', 'right')!, a = Traffic.spawn(L.net, L.seed, L.perKm, L.map.start, L.extras), b = Traffic.spawn(L.net, L.seed, L.perKm, L.map.start, L.extras);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.cars.filter(c => c.state === 'parked' && a.places[c.place].slot === L.slot.id)).toHaveLength(1);
    expect(a.cars.filter(c => c.drv === 4)).toHaveLength(1);   // the thief (DRIVERS[4])
  });
});

describe('the street coach', () => {
  it('says each turn before its junction, the signal while guided, and the space at the end', () => {
    const v = VEHICLES['byd-atto2'], L = load('byd-atto2', 'street-traffic', 'right')!, said: StreetEvent[] = [];
    const guided = new StreetCoach(L, 0, 'right');
    streetDrive(v, L, { kmh: 30 }, 'ma', sim => { if (sim.mode === 'drive') said.push(...guided.observe(v, sim.x, sim.z, sim.th, 0)); });
    const titles = said.flatMap(e => (e.type === 'say' ? [e.title] : []));
    expect(titles).toEqual(['Turn left', 'Signal left', 'Turn right', 'Signal right', 'Your space']);   // never signalled (ind 0 passed in): reminded
    const first = said.find(e => e.type === 'say')!;
    expect(first.type === 'say' && first.text).toContain('At the lights, turn left into Market Street.');
  }, 60000);
  it('finds a new way to the same space when you leave it', () => {
    const v = VEHICLES['byd-atto2'], L = load('byd-atto2', 'street-traffic', 'right')!, c = new StreetCoach(L, 0, 'right');
    const lane = L.net.els.find(e => e.kind === 'lane' && e.street === 'quay')!, [x, z] = [lane.pieces[0].x + 10 * Math.cos(lane.pieces[0].h), lane.pieces[0].z - 10 * Math.sin(lane.pieces[0].h)];
    const evs = c.observe(v, x - (v.L - v.OVR) * Math.cos(lane.pieces[0].h), z + (v.L - v.OVR) * Math.sin(lane.pieces[0].h), lane.pieces[0].h, 0);
    expect(evs.some(e => e.type === 'reroute')).toBe(true);
    const end = c.pts[c.pts.length - 1], was = L.pts[L.pts.length - 1];
    expect(Math.hypot(end.x - was.x, end.z - was.z)).toBeLessThan(0.6);
  });
});

describe('driving the street lessons', () => {
  for (const l of LESSONS) for (const [id, drive] of DRIVEN) {
    // a careful driver passes (all of them try, with STREET_ALL: the robot's own parking at the end now and then misses
    // in one car at one speed, which says more about the robot than the lesson)
    it(`${l.n} ${l.title}: a careful driver passes in the ${id}, traffic keeping ${drive}`, () => {
      const L = load(id, l.id, drive)!, why: string[] = [];
      for (const [name, o] of ALL ? STREET_DRIVERS : STREET_DRIVERS.slice(0, 1)) {
        const res = streetDrive(VEHICLES[id], L, o, drive === 'left' ? 'gb' : 'ma'), chk = checkStreetPass(res.r, L.slot.id, res.faults);
        if (chk.pass) return;
        why.push(`${name}: ${res.why} ${chk.lines.filter(q => !q.ok).map(q => q.text).join('; ')}`);
      }
      expect.fail(why.join(' / '));
    }, 120000);
  }
  it('a driver who never signals does not pass, and one who waits too long loses the space to the thief', () => {
    const v = VEHICLES['byd-atto2'];
    for (const l of LESSONS) {
      const L = load('byd-atto2', l.id, 'right')!, res = streetDrive(v, L, STREET_FAILERS[0][1]);
      expect(res.faults.some(f => f.kind === 'signal')).toBe(true);
      expect(checkStreetPass(res.r, L.slot.id, res.faults).pass).toBe(false);
    }
    const L = load('byd-atto2', 'street-leavers', 'right')!, res = streetDrive(v, L, STREET_FAILERS[1][1]);
    expect(res.took).toBe(true);
    expect(checkStreetPass(res.r, L.slot.id, res.faults).pass).toBe(false);
  }, 120000);
});
