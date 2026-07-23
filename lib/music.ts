export type MusicEvent = {
  id: string;
  measure: number;
  partId: string;
  partName: string;
  staff: number;
  voice: string;
  startBeat: number;
  durationBeats: number;
  midi: number[];
  names: string[];
  isRest: boolean;
};

export type ScoreData = {
  title: string;
  composer: string;
  bpm: number;
  beatsPerMeasure: number;
  measureCount: number;
  totalBeats?: number;
  events: MusicEvent[];
  parts: Array<{ id: string; name: string }>;
  sourceXml?: string;
};

const STEP: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const SOLFEGE: Record<string, string> = {
  C: "до",
  D: "ре",
  E: "ми",
  F: "фа",
  G: "соль",
  A: "ля",
  B: "си",
};

function text(node: ParentNode, selector: string, fallback = "") {
  return node.querySelector(selector)?.textContent?.trim() || fallback;
}

function pitchName(step: string, alter: number, octave: number, solfege = false) {
  const accidental = alter === 1 ? "♯" : alter === -1 ? "♭" : "";
  return `${solfege ? SOLFEGE[step] : step}${accidental}${octave}`;
}

export function parseMusicXml(xml: string): ScoreData {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Файл содержит некорректный XML.");
  }
  const score = doc.querySelector("score-partwise, score-timewise");
  if (!score) throw new Error("Это XML-файл, но в нём нет партитуры MusicXML.");

  const title =
    text(doc, "work-title") ||
    text(doc, "movement-title") ||
    "Без названия";
  const composer =
    [...doc.querySelectorAll("identification creator")]
      .find((node) => node.getAttribute("type") === "composer")
      ?.textContent?.trim() || "";
  const partNames = new Map<string, string>();
  doc.querySelectorAll("part-list score-part").forEach((part) => {
    const id = part.getAttribute("id") || `part-${partNames.size + 1}`;
    partNames.set(id, text(part, "part-name", `Партия ${partNames.size + 1}`));
  });

  let bpm = Number(text(doc, "sound[tempo]", "0"));
  if (!bpm) {
    const sound = doc.querySelector("sound[tempo]");
    bpm = Number(sound?.getAttribute("tempo")) || 96;
  }
  let beatsPerMeasure = 4;
  const events: MusicEvent[] = [];
  let measureCount = 0;
  let totalBeats = 0;

  doc.querySelectorAll(":scope > part, score-partwise > part").forEach(
    (partNode) => {
      const partId = partNode.getAttribute("id") || "P1";
      const partName = partNames.get(partId) || partId;
      let divisions = 1;
      let absoluteBeat = 0;
      let measureBeats = 4;

      partNode.querySelectorAll(":scope > measure").forEach((measureNode, mi) => {
        const measure = Number(measureNode.getAttribute("number")) || mi + 1;
        measureCount = Math.max(measureCount, measure);
        divisions =
          Number(text(measureNode, "attributes divisions", String(divisions))) ||
          divisions;
        const beats =
          Number(text(measureNode, "attributes time beats", "0")) || 0;
        const beatType =
          Number(text(measureNode, "attributes time beat-type", "0")) || 0;
        if (beats && beatType) measureBeats = beats * (4 / beatType);
        beatsPerMeasure = measureBeats;
        const tempo = measureNode.querySelector("sound[tempo]")?.getAttribute("tempo");
        if (tempo && events.length === 0) bpm = Number(tempo) || bpm;

        const measureStart = absoluteBeat;
        let cursor = 0;
        let furthestCursor = 0;
        let previousStart = 0;
        let noteIndex = 0;

        [...measureNode.children].forEach((child) => {
          const tag = child.localName;
          if (tag === "backup" || tag === "forward") {
            const rawDuration = Number(text(child, "duration", "0")) || 0;
            const duration = rawDuration / divisions;
            cursor =
              tag === "backup"
                ? Math.max(0, cursor - duration)
                : cursor + duration;
            furthestCursor = Math.max(furthestCursor, cursor);
            return;
          }
          if (tag !== "note") return;

          const note = child;
          const rawDuration = Number(text(note, ":scope > duration", "0")) || 0;
          const duration = rawDuration / divisions;
          const isChord = Boolean(note.querySelector(":scope > chord"));
          const isRest = Boolean(note.querySelector(":scope > rest"));
          const relativeStart = isChord ? previousStart : cursor;
          const startBeat = measureStart + relativeStart;
          if (!isChord) {
            previousStart = relativeStart;
            cursor += duration;
            furthestCursor = Math.max(furthestCursor, cursor);
          }
          const staff = Number(text(note, "staff", "1")) || 1;
          const voice = text(note, "voice", "1");
          let midi: number[] = [];
          let names: string[] = [];
          if (!isRest) {
            const step = text(note, "pitch step", "C");
            const alter = Number(text(note, "pitch alter", "0")) || 0;
            const octave = Number(text(note, "pitch octave", "4")) || 4;
            midi = [(octave + 1) * 12 + STEP[step] + alter];
            names = [pitchName(step, alter, octave)];
          }

          const existing = events.find(
            (event) =>
              event.partId === partId &&
              event.measure === measure &&
              Math.abs(event.startBeat - startBeat) < 0.0001 &&
              event.voice === voice &&
              event.staff === staff &&
              !event.isRest &&
              !isRest,
          );
          if (existing && isChord) {
            existing.midi.push(...midi);
            existing.names.push(...names);
            existing.durationBeats = Math.max(existing.durationBeats, duration);
          } else {
            events.push({
              id: `${partId}-m${measure}-n${noteIndex}`,
              measure,
              partId,
              partName,
              staff,
              voice,
              startBeat,
              durationBeats: duration,
              midi,
              names,
              isRest,
            });
          }
          noteIndex += 1;
        });
        const implicit = measureNode.getAttribute("implicit") === "yes";
        absoluteBeat += implicit
          ? Math.max(furthestCursor, 0)
          : Math.max(measureBeats, furthestCursor);
      });
      totalBeats = Math.max(totalBeats, absoluteBeat);
    },
  );

  if (!events.length) throw new Error("В партитуре не найдено музыкальных событий.");
  totalBeats = Math.max(
    totalBeats,
    ...events.map((event) => event.startBeat + event.durationBeats),
  );
  return {
    title,
    composer,
    bpm,
    beatsPerMeasure,
    measureCount,
    totalBeats,
    events: events.sort(
      (a, b) => a.startBeat - b.startBeat || a.partId.localeCompare(b.partId),
    ),
    parts: [...partNames].map(([id, name]) => ({ id, name })),
    sourceXml: xml,
  };
}

export function eventSeconds(event: MusicEvent, bpm: number, speed = 1) {
  return (event.startBeat * 60) / (bpm * speed);
}

export function durationSeconds(event: MusicEvent, bpm: number, speed = 1) {
  return (event.durationBeats * 60) / (bpm * speed);
}

export function scoreDuration(score: ScoreData, speed = 1) {
  const totalBeats =
    score.totalBeats ??
    Math.max(
      score.measureCount * score.beatsPerMeasure,
      ...score.events.map((event) => event.startBeat + event.durationBeats),
    );
  return (totalBeats * 60) / (score.bpm * speed);
}

export function eventsInRange(
  score: ScoreData,
  fromMeasure: number,
  toMeasure: number,
  enabledParts: Set<string>,
) {
  return score.events.filter(
    (event) =>
      event.measure >= fromMeasure &&
      event.measure <= toMeasure &&
      enabledParts.has(event.partId),
  );
}

export function formatTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60)
    .toString()
    .padStart(2, "0")}`;
}

export function nameForMidi(midi: number, solfege = false) {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const sol = ["до", "до♯", "ре", "ре♯", "ми", "фа", "фа♯", "соль", "соль♯", "ля", "ля♯", "си"];
  const octave = Math.floor(midi / 12) - 1;
  return `${(solfege ? sol : names)[midi % 12]}${octave}`;
}
