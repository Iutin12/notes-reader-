import assert from "node:assert/strict";
import test from "node:test";
import {
  MusicEvent,
  ScoreData,
  durationSeconds,
  eventSeconds,
  eventsInRange,
  formatTime,
  nameForMidi,
  scoreDuration,
} from "../lib/music";

const events: MusicEvent[] = [
  { id: "a", measure: 1, partId: "right", partName: "Правая", staff: 1, voice: "1", startBeat: 0, durationBeats: 1, midi: [60], names: ["C4"], isRest: false },
  { id: "chord", measure: 2, partId: "right", partName: "Правая", staff: 1, voice: "1", startBeat: 4, durationBeats: 2, midi: [60, 64, 67], names: ["C4", "E4", "G4"], isRest: false },
  { id: "rest", measure: 2, partId: "left", partName: "Левая", staff: 2, voice: "1", startBeat: 6, durationBeats: 1, midi: [], names: [], isRest: true },
];

const score: ScoreData = {
  title: "Test",
  composer: "",
  bpm: 120,
  beatsPerMeasure: 4,
  measureCount: 2,
  events,
  parts: [
    { id: "right", name: "Правая" },
    { id: "left", name: "Левая" },
  ],
};

test("calculates timing and speed without losing musical position", () => {
  assert.equal(eventSeconds(events[1], 120), 2);
  assert.equal(eventSeconds(events[1], 120, 0.5), 4);
  assert.equal(durationSeconds(events[1], 120), 1);
  assert.equal(scoreDuration(score), 4);
  assert.equal(scoreDuration(score, 2), 2);
});

test("keeps a chord as one simultaneous event and preserves rests", () => {
  assert.deepEqual(events[1].midi, [60, 64, 67]);
  assert.equal(events[1].durationBeats, 2);
  assert.equal(events[2].isRest, true);
  assert.deepEqual(events[2].midi, []);
});

test("selects measures and parts for fragment practice", () => {
  const rightOnly = eventsInRange(score, 2, 2, new Set(["right"]));
  assert.deepEqual(rightOnly.map((event) => event.id), ["chord"]);
  const all = eventsInRange(score, 1, 2, new Set(["right", "left"]));
  assert.equal(all.length, 3);
});

test("formats time and both note naming systems", () => {
  assert.equal(formatTime(65.9), "1:05");
  assert.equal(nameForMidi(61), "C♯4");
  assert.equal(nameForMidi(60, true), "до4");
});
