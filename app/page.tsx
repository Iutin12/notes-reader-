"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Midi } from "@tonejs/midi";
import JSZip from "jszip";
import { PianoSynth } from "../lib/audio";
import {
  MusicEvent,
  ScoreData,
  durationSeconds,
  eventsInRange,
  formatTime,
  nameForMidi,
  parseMusicXml,
  scoreDuration,
} from "../lib/music";

type Mode = "continuous" | "event" | "measure" | "fragment" | "training";
type SavedScore = {
  name: string;
  fileName: string;
  xml: string;
  bpm?: number;
  savedAt: number;
  edits?: Array<{ id: string; midi: number[]; durationBeats?: number }>;
  tags: string[];
  notes: string;
};
type OmrStage =
  | "uploading"
  | "queued"
  | "preparing"
  | "recognizing"
  | "building"
  | "ready"
  | "error"
  | "cancelled";
type OmrJob = {
  id: string;
  file_name: string;
  status: string;
  stage: OmrStage;
  message: string;
  page_count: number | null;
  detected_bpm: number | null;
  progress?: number;
  result_url: string | null;
  thumbnails: string[];
};
type FractionLike = {
  RealValue?: number;
  Numerator?: number;
  Denominator?: number;
  WholeValue?: number;
};
type OsmdIterator = {
  EndReached?: boolean;
  currentTimeStamp?: FractionLike;
  CurrentSourceTimestamp?: FractionLike;
  CurrentMeasureIndex?: number;
  CurrentRelativeInMeasureTimestamp?: FractionLike;
};
type OsmdCursor = {
  reset(): void;
  next(): void;
  show(): void;
  hide(): void;
  update(): void;
  Iterator?: OsmdIterator;
  iterator?: OsmdIterator;
  cursorElement?: HTMLElement;
  GNotesUnderCursor?(): GraphicalNoteLike[];
};
type GraphicalNoteLike = {
  setColor(color: string, options: Record<string, boolean>): void;
};
type OsmdInstance = {
  cursor: OsmdCursor;
};
type ScoreClickPosition = {
  beat: number;
  x: number;
  y: number;
  height: number;
};
type PianoKeyHand = "left" | "right" | "both";
type PianoKeyState = { midi: number; hand: PianoKeyHand };
type EditorNote = {
  id: string;
  midi: number;
  startBeat: number;
  durationBeats: number;
  staff: number;
  voice: string;
  originalMidi?: number;
  originalStartBeat?: number;
};
type EditorDrag = { noteId: string; startX: number; startY: number; midi: number; startBeat: number; staff: number; rollWidth: number };

const PIANO_LOW_MIDI = 36; // C2
const PIANO_HIGH_MIDI = 96; // C7
const blackPitchClasses = new Set([1, 3, 6, 8, 10]);
const editorTimelineStart = 7;
const editorTimelineWidth = 91;
const diatonicPitchClasses = [0, 2, 4, 5, 7, 9, 11];

function diatonicStepForMidi(midi: number) {
  const octave = Math.floor(midi / 12) - 1;
  const pitchClass = ((midi % 12) + 12) % 12;
  const step = pitchClass <= 1 ? 0 : pitchClass <= 3 ? 1 : pitchClass === 4 ? 2 : pitchClass <= 6 ? 3 : pitchClass <= 8 ? 4 : pitchClass <= 10 ? 5 : 6;
  return octave * 7 + step;
}

function midiForDiatonicStep(step: number) {
  const octave = Math.floor(step / 7);
  return (octave + 1) * 12 + diatonicPitchClasses[((step % 7) + 7) % 7];
}

function editorNoteTop(midi: number, staff: number) {
  // The middle line is B4 in treble and D3 in bass. One diatonic step is
  // half the distance between staff lines, so sharps/flats stay on one line.
  const center = staff === 1 ? 25 : 75;
  const centerStep = staff === 1 ? diatonicStepForMidi(71) : diatonicStepForMidi(50);
  return center - (diatonicStepForMidi(midi) - centerStep) * 2.63;
}

function editorLedgerTops(midi: number, staff: number) {
  const centerStep = staff === 1 ? diatonicStepForMidi(71) : diatonicStepForMidi(50);
  const delta = diatonicStepForMidi(midi) - centerStep;
  const steps: number[] = [];
  if (delta > 4) for (let step = 6; step <= delta; step += 2) steps.push(centerStep + step);
  if (delta < -4) for (let step = -6; step >= delta; step -= 2) steps.push(centerStep + step);
  return steps.map((step) => {
    const center = staff === 1 ? 25 : 75;
    return center - (step - centerStep) * 2.63;
  });
}

function editorNoteLeft(startBeat: number, beatsPerMeasure: number) {
  return editorTimelineStart + (startBeat / beatsPerMeasure) * editorTimelineWidth;
}

function isBlackPianoKey(midi: number) {
  return blackPitchClasses.has(((midi % 12) + 12) % 12);
}

function musicXmlPitch(midi: number) {
  const names = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
  const alters = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  const safeMidi = Math.max(0, Math.min(127, midi));
  const pitchClass = safeMidi % 12;
  return { step: names[pitchClass], alter: alters[pitchClass], octave: Math.floor(safeMidi / 12) - 1 };
}

function notationForBeats(beats: number) {
  const options = [
    [0.125, "32nd", 0], [0.25, "16th", 0], [0.375, "16th", 1],
    [0.5, "eighth", 0], [0.75, "eighth", 1], [1, "quarter", 0],
    [1.5, "quarter", 1], [2, "half", 0], [3, "half", 1],
    [4, "whole", 0], [6, "whole", 1], [8, "breve", 0],
  ] as const;
  return options.reduce((best, option) =>
    Math.abs(option[0] - beats) < Math.abs(best[0] - beats) ? option : best,
  );
}

function applyMeasureEditorToMusicXml(
  xml: string,
  partId: string,
  measureNumber: number,
  notes: EditorNote[],
  beatsPerMeasure: number,
) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return xml;
  const part = [...doc.querySelectorAll("score-partwise > part")]
    .find((node) => node.getAttribute("id") === partId);
  if (!part) return xml;
  const measure = [...part.querySelectorAll(":scope > measure")]
    .find((node, index) => (node.getAttribute("number") || String(index + 1)) === String(measureNumber));
  if (!measure) return xml;
  let divisions = 1;
  for (const previousMeasure of part.querySelectorAll(":scope > measure")) {
    const found = Number(previousMeasure.querySelector(":scope > attributes > divisions")?.textContent || "0");
    if (found) divisions = found;
    if (previousMeasure === measure) break;
  }
  [...measure.children].filter((node) => ["note", "backup", "forward"].includes(node.localName)).forEach((node) => node.remove());
  const finalBarline = measure.querySelector(":scope > barline");
  const insertMusicNode = (node: Element) => measure.insertBefore(node, finalBarline);
  const appendText = (parent: Element, name: string, value: string) => {
    const child = doc.createElement(name);
    child.textContent = value;
    parent.appendChild(child);
  };
  const appendForward = (duration: number) => {
    if (duration <= 0) return;
    const forward = doc.createElement("forward");
    appendText(forward, "duration", String(Math.max(1, Math.round(duration * divisions))));
    insertMusicNode(forward);
  };
  const orderedStaves = [...new Set(notes.map((note) => note.staff))].sort((a, b) => a - b);
  orderedStaves.forEach((staff, staffIndex) => {
    if (staffIndex > 0) {
      const backup = doc.createElement("backup");
      appendText(backup, "duration", String(Math.max(1, Math.round(beatsPerMeasure * divisions))));
      insertMusicNode(backup);
    }
    let cursor = 0;
    const staffNotes = notes.filter((note) => note.staff === staff).sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
    for (const group of Object.values(Object.groupBy(staffNotes, (note) => String(note.startBeat)))) {
      if (!group?.length) continue;
      const startBeat = group[0].startBeat;
      appendForward(startBeat - cursor);
      group.forEach((note, index) => {
        const element = doc.createElement("note");
        if (index) element.appendChild(doc.createElement("chord"));
        const pitch = musicXmlPitch(note.midi);
        const pitchNode = doc.createElement("pitch");
        appendText(pitchNode, "step", pitch.step);
        if (pitch.alter) appendText(pitchNode, "alter", String(pitch.alter));
        appendText(pitchNode, "octave", String(pitch.octave));
        element.appendChild(pitchNode);
        appendText(element, "duration", String(Math.max(1, Math.round(note.durationBeats * divisions))));
        const [, type, dots] = notationForBeats(note.durationBeats);
        appendText(element, "voice", note.voice || "1");
        appendText(element, "type", type);
        for (let indexDot = 0; indexDot < dots; indexDot += 1) element.appendChild(doc.createElement("dot"));
        appendText(element, "staff", String(staff));
        insertMusicNode(element);
      });
      cursor = Math.max(cursor, startBeat + Math.max(...group.map((note) => note.durationBeats)));
    }
  });
  return new XMLSerializer().serializeToString(doc);
}

function PianoKeyboard({
  keys,
  pressedNotes = [],
  onKeyPress,
}: {
  keys: PianoKeyState[];
  pressedNotes?: number[];
  onKeyPress?: (midi: number) => void;
}) {
  const allKeys = Array.from(
    { length: PIANO_HIGH_MIDI - PIANO_LOW_MIDI + 1 },
    (_, index) => PIANO_LOW_MIDI + index,
  );
  const whiteKeys = allKeys.filter((midi) => !isBlackPianoKey(midi));
  const active = new Map(keys.map((key) => [key.midi, key.hand]));
  const pressed = new Set(pressedNotes);
  return (
    <div className="keyboard-guide" aria-label="Клавиатура фортепиано">
      <div className="keyboard-guide-heading">
        <span>Клавиши аккорда</span>
        <small>{keys.length ? keys.map((key) => nameForMidi(key.midi, false)).join(" · ") : "Нажмите на ноту в партитуре"}</small>
      </div>
      <div className="piano-keyboard" style={{ "--white-key-count": whiteKeys.length } as React.CSSProperties}>
        {whiteKeys.map((midi) => (
          <button
            type="button"
            onClick={() => onKeyPress?.(midi)}
            className={`piano-key white ${active.get(midi) || ""} ${pressed.has(midi) ? "pressed" : ""}`}
            key={midi}
            title={`${nameForMidi(midi, true)} (${nameForMidi(midi, false)})`}
            aria-label={`${nameForMidi(midi, true)}, ${nameForMidi(midi, false)}`}
          >
            <b>{nameForMidi(midi, true)}</b>
          </button>
        ))}
        {allKeys.filter(isBlackPianoKey).map((midi) => {
          const whitesBefore = whiteKeys.filter((white) => white < midi).length;
          return (
            <button
              type="button"
              onClick={() => onKeyPress?.(midi)}
              className={`piano-key black ${active.get(midi) || ""} ${pressed.has(midi) ? "pressed" : ""}`}
              key={midi}
              style={{ left: `${(whitesBefore / whiteKeys.length) * 100}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const PDF_MAX_FILE_SIZE = 50 * 1024 * 1024;
const OMR_STAGES: Array<{ stage: OmrStage; label: string }> = [
  { stage: "uploading", label: "Загрузка" },
  { stage: "preparing", label: "Подготовка страниц" },
  { stage: "recognizing", label: "Распознавание" },
  { stage: "building", label: "Создание партитуры" },
  { stage: "ready", label: "Готово" },
];

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

declare global {
  interface Window {
    noteraDesktop?: { omrBaseUrl?: string };
  }
}

function omrRequestUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input !== "string" || !input.startsWith("/api/omr/")) return input;
  const baseUrl = window.noteraDesktop?.omrBaseUrl;
  return baseUrl ? `${baseUrl}${input}` : input;
}

async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  attempts = 3,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(omrRequestUrl(input), init);
      if (
        response.status < 500 ||
        attempt === attempts - 1
      ) {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await wait(700 * (attempt + 1));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Сервис распознавания временно недоступен.");
}

function simplifyMusicXmlForRendering(xml: string) {
  return xml
    .replace(/<beam\b[^>]*>[\s\S]*?<\/beam\s*>/gi, "")
    .replace(/<notations\b[^>]*>[\s\S]*?<\/notations\s*>/gi, "")
    // Fallback only: malformed OMR directions can make OSMD render a blank
    // page. The first rendering attempt keeps them intact.
    .replace(/<direction\b[^>]*>[\s\S]*?<\/direction\s*>/gi, "")
    .replace(/<print\b[^>]*>[\s\S]*?<\/print\s*>/gi, "");
}

function displayNameFromFile(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "") || fileName;
}

function renderReadableFallback(container: HTMLElement, data: ScoreData) {
  const ns = "http://www.w3.org/2000/svg";
  const measuresPerRow = 4;
  const measureWidth = 220;
  const rowHeight = 180;
  const rows = Math.ceil(data.measureCount / measuresPerRow);
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${measureWidth * measuresPerRow + 40} ${rows * rowHeight + 40}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Упрощённое отображение распознанных нот");
  const line = (x1: number, y1: number, x2: number, y2: number, width = 1) => {
    const element = document.createElementNS(ns, "line");
    element.setAttribute("x1", String(x1)); element.setAttribute("y1", String(y1));
    element.setAttribute("x2", String(x2)); element.setAttribute("y2", String(y2));
    element.setAttribute("stroke", "#18251f"); element.setAttribute("stroke-width", String(width));
    svg.appendChild(element);
  };
  const text = (value: string, x: number, y: number) => {
    const element = document.createElementNS(ns, "text");
    element.textContent = value; element.setAttribute("x", String(x)); element.setAttribute("y", String(y));
    element.setAttribute("font-size", "13"); element.setAttribute("fill", "#18251f"); svg.appendChild(element);
  };
  for (let row = 0; row < rows; row += 1) {
    const top = 26 + row * rowHeight;
    for (const staffTop of [top, top + 82]) {
      for (let index = 0; index < 5; index += 1) line(20, staffTop + index * 10, measureWidth * measuresPerRow + 20, staffTop + index * 10);
    }
    for (let column = 0; column <= measuresPerRow; column += 1) line(20 + column * measureWidth, top, 20 + column * measureWidth, top + 122, column === 0 || column === measuresPerRow ? 2 : 1);
    for (let offset = 0; offset < measuresPerRow; offset += 1) {
      const measure = row * measuresPerRow + offset + 1;
      if (measure <= data.measureCount) text(String(measure), 26 + offset * measureWidth, top - 7);
    }
  }
  data.events.filter((event) => !event.isRest).forEach((event) => {
    const row = Math.floor((event.measure - 1) / measuresPerRow);
    const column = (event.measure - 1) % measuresPerRow;
    const top = 26 + row * rowHeight;
    const measureEvents = data.events.filter((item) => item.measure === event.measure && !item.isRest);
    const index = Math.max(0, measureEvents.findIndex((item) => item.id === event.id));
    const x = 42 + column * measureWidth + (index + 1) * ((measureWidth - 36) / (measureEvents.length + 1));
    event.midi.forEach((midi) => {
      const staffTop = event.staff === 2 ? top + 82 : top;
      const reference = event.staff === 2 ? 48 : 72;
      const y = Math.max(staffTop - 16, Math.min(staffTop + 56, staffTop + 40 - (midi - reference) * 2.8));
      const note = document.createElementNS(ns, "ellipse");
      note.setAttribute("cx", String(x)); note.setAttribute("cy", String(y)); note.setAttribute("rx", "6"); note.setAttribute("ry", "4.5"); note.setAttribute("fill", "#111"); svg.appendChild(note);
      line(x + 6, y, x + 6, y - 34, 1.4);
    });
  });
  container.appendChild(svg);
}

function fractionValue(fraction?: FractionLike) {
  if (!fraction) return 0;
  if (Number.isFinite(fraction.RealValue)) return fraction.RealValue || 0;
  const denominator = fraction.Denominator || 1;
  return (
    (fraction.WholeValue || 0) +
    (fraction.Numerator || 0) / denominator
  );
}

function cursorBeat(cursor?: OsmdCursor) {
  const iterator = cursor?.Iterator || cursor?.iterator;
  return (
    fractionValue(
      iterator?.CurrentSourceTimestamp || iterator?.currentTimeStamp,
    ) * 4
  );
}

function Icon({ children }: { children: React.ReactNode }) {
  return <span aria-hidden="true">{children}</span>;
}

function loadSaved(): SavedScore[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem("notera-scores") || "[]") as Partial<SavedScore>[];
    return parsed
      .filter((item) => typeof item.name === "string" && typeof item.xml === "string" && typeof item.savedAt === "number")
      .map((item) => ({
        name: item.name!,
        fileName: item.fileName || `${item.name}.musicxml`,
        xml: item.xml!,
        bpm: item.bpm,
        savedAt: item.savedAt!,
        edits: item.edits,
        tags: Array.isArray(item.tags)
          ? item.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
          : [],
        notes: typeof item.notes === "string" ? item.notes : "",
      }));
  } catch {
    return [];
  }
}

function midiToScore(buffer: ArrayBuffer, fileName: string): ScoreData {
  const midi = new Midi(buffer);
  const bpm = midi.header.tempos[0]?.bpm || 120;
  const beatsPerMeasure = midi.header.timeSignatures[0]?.timeSignature[0] || 4;
  const parts = midi.tracks.flatMap((track, index) =>
    track.notes.length
      ? [
          {
            id: `track-${index}`,
            name:
              track.name ||
              track.instrument.name ||
              `Дорожка ${index + 1}`,
          },
        ]
      : [],
  );
  const events: MusicEvent[] = [];
  midi.tracks.forEach((track, trackIndex) => {
    const part = parts.find((item) => item.id === `track-${trackIndex}`) || {
      id: `track-${trackIndex}`,
      name: `Дорожка ${trackIndex + 1}`,
    };
    const groups = new Map<string, MusicEvent>();
    track.notes.forEach((note, index) => {
      const startBeat = (note.time * bpm) / 60;
      const key = `${Math.round(startBeat * 1000)}-${part.id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.midi.push(note.midi);
        existing.names.push(note.name);
        existing.durationBeats = Math.max(
          existing.durationBeats,
          (note.duration * bpm) / 60,
        );
      } else {
        groups.set(key, {
          id: `${part.id}-n${index}`,
          measure: Math.floor(startBeat / beatsPerMeasure) + 1,
          partId: part.id,
          partName: part.name,
          staff: 1,
          voice: "1",
          startBeat,
          durationBeats: (note.duration * bpm) / 60,
          midi: [note.midi],
          names: [note.name],
          isRest: false,
        });
      }
    });
    events.push(...groups.values());
  });
  if (!events.length) throw new Error("В MIDI-файле не найдено нот.");
  const maxBeat = Math.max(
    ...events.map((event) => event.startBeat + event.durationBeats),
  );
  return {
    title: fileName.replace(/\.(mid|midi)$/i, ""),
    composer: "",
    bpm,
    beatsPerMeasure,
    measureCount: Math.ceil(maxBeat / beatsPerMeasure),
    totalBeats: maxBeat,
    parts,
    events: events.sort((a, b) => a.startBeat - b.startBeat),
  };
}

export default function Home() {
  const [score, setScore] = useState<ScoreData | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState<SavedScore[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryTag, setLibraryTag] = useState("");
  const [editingSavedAt, setEditingSavedAt] = useState<number | null>(null);
  const [libraryTagsDraft, setLibraryTagsDraft] = useState("");
  const [libraryNotesDraft, setLibraryNotesDraft] = useState("");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [currentEvent, setCurrentEvent] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [tempoInput, setTempoInput] = useState("120");
  const [volume, setVolume] = useState(0.7);
  const [transpose, setTranspose] = useState(0);
  const [mode, setMode] = useState<Mode>("continuous");
  const [repeat, setRepeat] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [metronomeVolume, setMetronomeVolume] = useState(0.5);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(1);
  const [enabledParts, setEnabledParts] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showNames, setShowNames] = useState(false);
  const [solfege, setSolfege] = useState(true);
  // Manual reading should not fight the player. Users can enable following
  // playback explicitly in settings when they want the score to scroll.
  const [autoScroll, setAutoScroll] = useState(false);
  const [keyboardGuide, setKeyboardGuide] = useState(false);
  const [trainingAttempt, setTrainingAttempt] = useState({ eventId: "", pressed: [] as number[], feedback: "" });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMeasure, setEditorMeasure] = useState(1);
  const [editorPartId, setEditorPartId] = useState("");
  const [editorNotes, setEditorNotes] = useState<EditorNote[]>([]);
  const [editorBeatsPerMeasure, setEditorBeatsPerMeasure] = useState(4);
  const [selectedEditorNote, setSelectedEditorNote] = useState("");
  const [editorDrag, setEditorDrag] = useState<EditorDrag | null>(null);
  const [countIn, setCountIn] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [omrJob, setOmrJob] = useState<OmrJob | null>(null);
  const [pendingPdf, setPendingPdf] = useState<File | null>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OsmdInstance | null>(null);
  const scoreClickPositionsRef = useRef<ScoreClickPosition[]>([]);
  const cursorBeatRef = useRef(0);
  const autoScrollRef = useRef(false);
  const highlightedNotesRef = useRef<GraphicalNoteLike[]>([]);
  const synthRef = useRef(new PianoSynth());
  const timersRef = useRef<number[]>([]);
  const playStartedRef = useRef(0);
  const positionStartedRef = useRef(0);
  const scheduleRef = useRef<
    (startIndex: number, oneOnly?: boolean) => Promise<void>
  >(() => Promise.resolve());

  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  useEffect(() => {
    void synthRef.current.preload().catch(() => {});
    const timer = window.setTimeout(() => {
      setSaved(loadSaved());
      const storedTheme = localStorage.getItem("notera-theme");
      if (storedTheme === "dark") setTheme("dark");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!score) return;
    const timer = window.setTimeout(
      () => setTempoInput(String(Math.round(score.bpm * speed))),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [score, speed]);

  const visibleEvents = useMemo(() => {
    if (!score) return [];
    const from = mode === "fragment" ? rangeStart : 1;
    const to = mode === "fragment" ? rangeEnd : score.measureCount;
    return eventsInRange(score, from, to, enabledParts);
  }, [score, enabledParts, mode, rangeStart, rangeEnd]);

  const totalDuration = score ? scoreDuration(score, speed) : 0;
  const active = visibleEvents[currentEvent] || null;
  const activeChordKeys = useMemo<PianoKeyState[]>(() => {
    if (!active) return [];
    const handsByMidi = new Map<number, Set<Exclude<PianoKeyHand, "both">>>();
    visibleEvents
      .filter((event) => Math.abs(event.startBeat - active.startBeat) < 0.0001)
      .forEach((event) => {
        // In a piano MusicXML part, staff 1 is normally the right hand and
        // staff 2 the left. The rule also keeps a same-pitch unison visible.
        const hand = event.staff <= 1 ? "right" : "left";
        event.midi.forEach((midi) => {
          const key = midi + transpose;
          const hands = handsByMidi.get(key) || new Set<Exclude<PianoKeyHand, "both">>();
          hands.add(hand);
          handsByMidi.set(key, hands);
        });
      });
    return [...handsByMidi.entries()]
      .map(([midi, hands]) => ({
        midi,
        hand: (hands.size > 1 ? "both" : [...hands][0] || "right") as PianoKeyHand,
      }))
      .sort((a, b) => a.midi - b.midi);
  }, [active, transpose, visibleEvents]);
  const trainingMode = mode === "training";
  const trainingPressed = trainingAttempt.eventId === active?.id ? trainingAttempt.pressed : [];
  const trainingFeedback = trainingAttempt.eventId === active?.id ? trainingAttempt.feedback : "";
  const currentMeasure = active?.measure || 1;
  const allLibraryTags = useMemo(
    () => [...new Set(saved.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b, "ru")),
    [saved],
  );
  const libraryItems = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase("ru-RU");
    return saved.filter((item) => {
      const matchesTag = !libraryTag || item.tags.includes(libraryTag);
      const haystack = [item.name, item.fileName, item.notes, ...item.tags]
        .join(" ")
        .toLocaleLowerCase("ru-RU");
      return matchesTag && (!query || haystack.includes(query));
    });
  }, [libraryQuery, libraryTag, saved]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }, []);

  const stop = useCallback(
    (reset = true) => {
      clearTimers();
      synthRef.current.stopAll();
      setPlaying(false);
      if (reset) {
        setPosition(0);
        setCurrentEvent(0);
        try {
          highlightedNotesRef.current.forEach((note) =>
            note.setColor("#000000", {
              applyToNoteheads: true,
              applyToStem: true,
              applyToFlag: true,
              applyToBeams: true,
              applyToLedgerLines: true,
            }),
          );
          highlightedNotesRef.current = [];
          osmdRef.current?.cursor?.reset();
          cursorBeatRef.current = 0;
        } catch {}
        const highlight =
          scoreRef.current?.querySelector<HTMLElement>(".playback-highlight");
        if (highlight) highlight.hidden = true;
      }
    },
    [clearTimers],
  );

  const collectScoreClickPositions = useCallback((
    cursor: OsmdCursor,
    data: ScoreData,
  ) => {
    const container = scoreRef.current;
    if (!container) return;
    const positions: ScoreClickPosition[] = [];
    const containerRect = container.getBoundingClientRect();
    cursor.reset();
    cursor.show();
    let guard = 0;
    while (guard < 10000) {
      cursor.update();
      const element = cursor.cursorElement;
      const rect = element?.getBoundingClientRect();
      if (rect && rect.height > 0) {
        const iterator = cursor.Iterator || cursor.iterator;
        const measure = (iterator?.CurrentMeasureIndex || 0) + 1;
        const measureStart = Math.min(
          ...data.events
            .filter((event) => event.measure === measure)
            .map((event) => event.startBeat),
        );
        const relativeBeat =
          fractionValue(iterator?.CurrentRelativeInMeasureTimestamp) * 4;
        positions.push({
          beat:
            Number.isFinite(measureStart)
              ? measureStart + relativeBeat
              : cursorBeat(cursor),
          x: rect.right - containerRect.left + container.scrollLeft,
          y:
            rect.top -
            containerRect.top +
            container.scrollTop +
            rect.height / 2,
          height: rect.height,
        });
      }
      const iterator = cursor.Iterator || cursor.iterator;
      if (iterator?.EndReached) break;
      const before = cursorBeat(cursor);
      cursor.next();
      if (cursorBeat(cursor) === before && iterator?.EndReached) break;
      guard += 1;
    }
    scoreClickPositionsRef.current = positions;
    cursor.reset();
    cursorBeatRef.current = 0;
    cursor.show();
    const previous = container.querySelector(".playback-highlight");
    previous?.remove();
    const highlight = document.createElement("div");
    highlight.className = "playback-highlight";
    highlight.hidden = true;
    highlight.setAttribute("aria-hidden", "true");
    container.appendChild(highlight);
  }, []);

  const renderScore = useCallback(
    async (data: ScoreData) => {
      if (!scoreRef.current) return;
      scoreRef.current.innerHTML = "";
      osmdRef.current = null;
      scoreClickPositionsRef.current = [];
      if (!data.sourceXml) return;
      try {
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
        const attempts = [
          { xml: data.sourceXml, simplified: false },
          { xml: simplifyMusicXmlForRendering(data.sourceXml), simplified: true },
        ];
        let lastFailure: unknown = null;
        for (const attempt of attempts) {
          try {
            scoreRef.current.innerHTML = "";
            const osmd = new OpenSheetMusicDisplay(scoreRef.current, {
              autoResize: true,
              backend: "svg",
              drawTitle: false,
              drawingParameters: "compacttight",
              followCursor: false,
              cursorsOptions: [
                {
                  type: 4,
                  color: "#2f6b57",
                  alpha: 0.16,
                  follow: false,
                },
              ],
            });
            await osmd.load(attempt.xml);
            osmd.render();
            if (!scoreRef.current.querySelector("svg path, svg use, svg rect")) {
              throw new Error("OSMD не создал нотные SVG-элементы.");
            }
            osmdRef.current = osmd;
            collectScoreClickPositions(osmd.cursor, data);
            if (attempt.simplified) {
              window.setTimeout(
                () =>
                  setNotice(
                    "Партитура показана в совместимом режиме: декоративная разметка, мешавшая отображению, скрыта; ноты и звук сохранены.",
                  ),
                0,
              );
            }
            window.setTimeout(() => setError(""), 0);
            return;
          } catch (caught) {
            lastFailure = caught;
          }
        }
        throw lastFailure;
      } catch (caught) {
        console.error("OSMD render failed", caught);
        if (scoreRef.current) {
          scoreRef.current.innerHTML = "";
          renderReadableFallback(scoreRef.current, data);
        }
        window.setTimeout(
          () =>
            setNotice(
              "Партитура показана в упрощённом режиме: часть разметки MusicXML несовместима с браузерным отображением, но распознанные ноты сохранены.",
            ),
          0,
        );
      }
    },
    [collectScoreClickPositions],
  );

  useEffect(() => {
    if (score) void renderScore(score);
  }, [score, renderScore]);

  const openScore = useCallback((data: ScoreData, sourceName: string) => {
    stop();
    setScore({ ...data, title: displayNameFromFile(sourceName) });
    setFileName(sourceName);
    setRangeStart(1);
    setRangeEnd(data.measureCount);
    setEnabledParts(new Set(data.parts.map((part) => part.id)));
    setError("");
    setNotice(
      data.sourceXml
        ? "Партитура готова. Нажмите воспроизведение — звук включится после вашего действия."
        : "MIDI импортирован. Для него доступна временная шкала и воспроизведение; точная нотная верстка из MIDI в этой версии не создаётся.",
    );
  }, [stop]);

  const persistScore = useCallback((data: ScoreData, sourceName: string, xml: string) => {
    const existing = loadSaved().find((item) => item.fileName === sourceName || item.name === displayNameFromFile(sourceName));
    const entry: SavedScore = {
      name: displayNameFromFile(sourceName),
      fileName: sourceName,
      xml,
      bpm: data.bpm,
      savedAt: Date.now(),
      edits: existing?.edits,
      tags: existing?.tags || [],
      notes: existing?.notes || "",
    };
    const next = [
      entry,
      ...loadSaved().filter((item) => item.fileName !== sourceName && item.name !== entry.name),
    ];
    try {
      localStorage.setItem("notera-scores", JSON.stringify(next));
      setSaved(next);
    } catch {
      setNotice("Партитура открыта, но браузер не смог сохранить её на этом устройстве.");
    }
  }, []);

  const processPdf = useCallback(
    async (file: File) => {
      if (file.size > PDF_MAX_FILE_SIZE) {
        setError("PDF больше 50 МБ. Уменьшите файл и попробуйте снова.");
        return;
      }
      setPendingPdf(file);
      setError("");
      setOmrJob({
        id: "",
        file_name: file.name,
        status: "uploading",
        stage: "uploading",
        message: "Передаём PDF в изолированный сервис распознавания…",
        page_count: null,
        detected_bpm: null,
        progress: 1,
        result_url: null,
        thumbnails: [],
      });
      try {
        const form = new FormData();
        form.append("file", file);
        const upload = await fetchWithRetry("/api/omr/jobs", {
          method: "POST",
          body: form,
        });
        if (!upload.ok) {
          let detail = `Сервис распознавания ответил с кодом ${upload.status}.`;
          try {
            const body = (await upload.json()) as { detail?: string };
            if (body.detail) detail = body.detail;
          } catch {}
          throw new Error(detail);
        }
        let job = (await upload.json()) as OmrJob;
        setOmrJob(job);

        while (!["ready", "error", "cancelled"].includes(job.status)) {
          await wait(1500);
          const statusResponse = await fetchWithRetry(`/api/omr/jobs/${job.id}`, {
            cache: "no-store",
          });
          if (!statusResponse.ok) {
            throw new Error("Не удалось получить состояние задачи распознавания.");
          }
          job = (await statusResponse.json()) as OmrJob;
          setOmrJob(job);
        }
        if (job.status === "error") throw new Error(job.message);
        if (job.status === "cancelled") return;
        if (!job.result_url) {
          throw new Error("Сервис завершил задачу без ссылки на MusicXML.");
        }
        const result = await fetchWithRetry(job.result_url, { cache: "no-store" });
        if (!result.ok) throw new Error("Не удалось получить готовый MusicXML.");
        const xml = await result.text();
        const data = parseMusicXml(xml);
        if (job.detected_bpm) data.bpm = job.detected_bpm;
        openScore(data, file.name);
        setNotice(
          job.detected_bpm
            ? `PDF распознан автоматически. Темп ${job.detected_bpm} BPM считан из первой страницы; проверьте высоту и длительность нот.`
            : "PDF распознан автоматически. Результат может содержать ошибки — проверьте высоту и длительность нот.",
        );
        persistScore(data, file.name, xml);
        setOmrJob(null);
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : "Не удалось распознать PDF.";
        setOmrJob((current) => ({
          id: current?.id || "",
          file_name: file.name,
          status: "error",
          stage: "error",
          message:
            message.includes("Failed to fetch")
              ? "Сервис распознавания перезапускается или временно недоступен. Подождите несколько секунд и нажмите «Запустить снова»."
              : message.includes("<!DOCTYPE") || message.includes("Unexpected token")
              ? "OMR-сервис недоступен. Перезапустите приложение; Docker Desktop для установщика не требуется."
              : message,
          page_count: current?.page_count || null,
          detected_bpm: current?.detected_bpm || null,
          progress: current?.progress || 0,
          result_url: null,
          thumbnails: current?.thumbnails || [],
        }));
      }
    },
    [openScore, persistScore],
  );

  const processFile = useCallback(
    async (file: File) => {
      setError("");
      setNotice("");
      if (
        file.size >
        (file.name.toLowerCase().endsWith(".pdf")
          ? PDF_MAX_FILE_SIZE
          : MAX_FILE_SIZE)
      ) {
        setError(
          file.name.toLowerCase().endsWith(".pdf")
            ? "PDF больше 50 МБ. Выберите файл меньшего размера."
            : "Файл больше 25 МБ. Выберите файл меньшего размера.",
        );
        return;
      }
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (!["musicxml", "xml", "mxl", "mid", "midi", "pdf"].includes(extension || "")) {
        setError("Поддерживаются PDF, MusicXML (.musicxml, .xml, .mxl) и MIDI.");
        return;
      }
      setLoading(true);
      try {
        if (extension === "pdf") {
          await processPdf(file);
          return;
        }
        if (extension === "mid" || extension === "midi") {
          openScore(midiToScore(await file.arrayBuffer(), file.name), file.name);
          return;
        }
        let xml = "";
        if (extension === "mxl") {
          const zip = await JSZip.loadAsync(await file.arrayBuffer());
          const container = await zip.file("META-INF/container.xml")?.async("text");
          const rootPath = container
            ? new DOMParser()
                .parseFromString(container, "application/xml")
                .querySelector("rootfile")
                ?.getAttribute("full-path")
            : Object.keys(zip.files).find((name) => /\.xml$/i.test(name));
          if (!rootPath || !zip.file(rootPath)) {
            throw new Error("В MXL-архиве не найден файл MusicXML.");
          }
          xml = await zip.file(rootPath)!.async("text");
        } else {
          xml = await file.text();
        }
        const data = parseMusicXml(xml);
        openScore(data, file.name);
        persistScore(data, file.name, xml);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Не удалось открыть файл.");
      } finally {
        setLoading(false);
      }
    },
    [openScore, persistScore, processPdf],
  );

  const cancelOmr = async () => {
    const current = omrJob;
    if (current?.id) {
      try {
        const response = await fetch(omrRequestUrl(`/api/omr/jobs/${current.id}`), {
          method: "DELETE",
        });
        if (response.ok) setOmrJob((await response.json()) as OmrJob);
      } catch {}
    }
    setOmrJob(null);
    setPendingPdf(null);
  };

  const openDemo = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/demo.musicxml");
      if (!response.ok) throw new Error("Демонстрационная партитура недоступна.");
      const xml = await response.text();
      openScore(parseMusicXml(xml), "Этюд для практики.musicxml");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось открыть демо.");
    } finally {
      setLoading(false);
    }
  }, [openScore]);

  const advanceCursor = useCallback((targetBeat: number, targetMeasure?: number) => {
    const cursor = osmdRef.current?.cursor;
    if (!cursor) return;
    try {
      const targetMeasureIndex =
        targetMeasure === undefined ? undefined : targetMeasure - 1;
      const measureStart =
        targetMeasure === undefined || !score
          ? 0
          : Math.min(
              ...score.events
                .filter((event) => event.measure === targetMeasure)
                .map((event) => event.startBeat),
            );
      const targetRelativeBeat = targetBeat - measureStart;
      const initialIterator = cursor.Iterator || cursor.iterator;
      const initialMeasureIndex = initialIterator?.CurrentMeasureIndex || 0;
      if (
        targetBeat + 0.0001 < cursorBeatRef.current ||
        (targetMeasureIndex !== undefined &&
          targetMeasureIndex < initialMeasureIndex)
      ) {
        cursor.reset();
        cursorBeatRef.current = 0;
      }
      let guard = 0;
      while (guard < 10000) {
        const iterator = cursor.Iterator || cursor.iterator;
        const currentMeasureIndex = iterator?.CurrentMeasureIndex || 0;
        const currentRelativeBeat =
          fractionValue(iterator?.CurrentRelativeInMeasureTimestamp) * 4;
        const beforeTarget =
          targetMeasureIndex === undefined
            ? cursorBeat(cursor) + 0.0001 < targetBeat
            : currentMeasureIndex < targetMeasureIndex ||
              (currentMeasureIndex === targetMeasureIndex &&
                currentRelativeBeat + 0.0001 < targetRelativeBeat);
        if (!beforeTarget) break;
        if (iterator?.EndReached) break;
        const before = cursorBeat(cursor);
        cursor.next();
        const after = cursorBeat(cursor);
        if (after === before && iterator?.EndReached) break;
        guard += 1;
      }
      cursorBeatRef.current = cursorBeat(cursor);
      cursor.show();
      highlightedNotesRef.current.forEach((note) =>
        note.setColor("#000000", {
          applyToNoteheads: true,
          applyToStem: true,
          applyToFlag: true,
          applyToBeams: true,
          applyToLedgerLines: true,
        }),
      );
      const currentNotes = cursor.GNotesUnderCursor?.() || [];
      currentNotes.forEach((note) =>
        note.setColor("#15945b", {
          applyToNoteheads: true,
          applyToStem: true,
          applyToFlag: true,
          applyToBeams: true,
          applyToLedgerLines: true,
        }),
      );
      highlightedNotesRef.current = currentNotes;
      const highlight =
        scoreRef.current?.querySelector<HTMLElement>(".playback-highlight");
      const scoreBounds = scoreRef.current?.getBoundingClientRect();
      const noteBounds = currentNotes
        .map((note) => {
          const element = (note as unknown as { getSVGGElement?: () => SVGElement })
            .getSVGGElement?.();
          return element?.getBoundingClientRect();
        })
        .filter((rect): rect is DOMRect => Boolean(rect && rect.width > 0 && rect.height > 0));
      if (highlight && scoreBounds && noteBounds.length) {
        // The OSMD cursor can span a whole staff and its cached coordinates can
        // differ after SVG reflow. Highlight the rendered noteheads instead.
        const left = Math.min(...noteBounds.map((rect) => rect.left));
        const top = Math.min(...noteBounds.map((rect) => rect.top));
        const bottom = Math.max(...noteBounds.map((rect) => rect.bottom));
        const center = (left + Math.max(...noteBounds.map((rect) => rect.right))) / 2;
        const osmdCursorBounds = cursor.cursorElement?.getBoundingClientRect();
        const systemTop = osmdCursorBounds && osmdCursorBounds.height > 0
          ? osmdCursorBounds.top
          : top - 38;
        const systemBottom = osmdCursorBounds && osmdCursorBounds.height > 0
          ? osmdCursorBounds.bottom
          : bottom + 38;
        const width = 16;
        highlight.hidden = false;
        // Use the current OSMD system bounds. The cursor stays inside the
        // active line (grand staff for piano), rather than spanning the page.
        highlight.style.left = `${center - scoreBounds.left - width / 2}px`;
        highlight.style.top = `${systemTop - scoreBounds.top}px`;
        highlight.style.width = `${width}px`;
        highlight.style.height = `${systemBottom - systemTop}px`;
        // Keep the actual note position separately for auto-scroll.
        highlight.dataset.scrollY = String(top - scoreBounds.top + (bottom - top) / 2);
      } else if (highlight) {
        highlight.hidden = true;
      }
    } catch {}
  }, [score]);

  const scheduleFrom = useCallback(
    async (startIndex: number, oneOnly = false) => {
      if (!score || !visibleEvents.length) return;
      clearTimers();
      synthRef.current.stopAll();
      try {
        await synthRef.current.resume();
      } catch (caught) {
        setPlaying(false);
        setError(
          caught instanceof Error
            ? `Не удалось включить звук: ${caught.message}`
            : "Браузер заблокировал воспроизведение звука.",
        );
        return;
      }
      setError("");
      synthRef.current.setVolume(volume);
      const startEvent = visibleEvents[Math.min(startIndex, visibleEvents.length - 1)];
      const beatSeconds = 60 / (score.bpm * speed);
      const countDelay = countIn * beatSeconds;
      const candidates =
        oneOnly || mode === "event"
          ? [startEvent]
          : mode === "measure"
            ? visibleEvents.filter((event) => event.measure === startEvent.measure)
            : visibleEvents.slice(startIndex);
      const baseBeat = startEvent.startBeat;
      const fragmentEndBeat =
        mode === "fragment" ? rangeEnd * score.beatsPerMeasure : Infinity;
      const scheduled = candidates.filter(
        (event) => event.startBeat < fragmentEndBeat,
      );
      const lastScheduled = scheduled[scheduled.length - 1];
      const nativePlayback = synthRef.current.isNativePlayback();

      if (nativePlayback) {
        const renderedNotes = scheduled.flatMap((event) =>
          event.midi.map((midi) => ({
            midi,
            offset: (event.startBeat - baseBeat) * beatSeconds,
            duration: durationSeconds(event, score.bpm, speed),
            transpose,
            polyphony: event.midi.length,
          })),
        );
        const renderedDuration = lastScheduled
          ? (lastScheduled.startBeat -
              baseBeat +
              lastScheduled.durationBeats) *
            beatSeconds
          : beatSeconds;
        try {
          await synthRef.current.playRendered(
            renderedNotes,
            renderedDuration,
            countDelay,
          );
        } catch (caught) {
          setError(
            caught instanceof Error
              ? `Не удалось собрать непрерывный звук: ${caught.message}`
              : "Safari не смог воспроизвести собранную аудиодорожку.",
          );
          return;
        }
      }

      setPlaying(true);
      setCurrentEvent(startIndex);
      playStartedRef.current = performance.now() + countDelay * 1000;
      positionStartedRef.current = (baseBeat * 60) / (score.bpm * speed);

      if (!nativePlayback && countIn > 0) {
        for (let beat = 0; beat < countIn; beat += 1) {
          synthRef.current.click(beat === 0, beat * beatSeconds, metronomeVolume);
        }
      }

      if (!nativePlayback) {
        const audioStartTime = synthRef.current.currentTime() + countDelay;
        let nextAudioEvent = 0;
        let nextMetronomeBeat = Math.ceil(baseBeat - 0.0001);
        let audioScheduler: number | null = null;
        const audioEndBeat = lastScheduled
          ? lastScheduled.startBeat + lastScheduled.durationBeats
          : baseBeat + 1;
        const scheduleAudioWindow = () => {
          const schedulerNow = synthRef.current.currentTime();
          const horizon = schedulerNow + 3;
          while (nextAudioEvent < scheduled.length) {
            const event = scheduled[nextAudioEvent];
            const targetTime =
              audioStartTime +
              (event.startBeat - baseBeat) * beatSeconds;
            if (targetTime > horizon) break;
            const delay = Math.max(0, targetTime - schedulerNow);
            event.midi.forEach((midi) =>
              synthRef.current.note(
                midi,
                durationSeconds(event, score.bpm, speed),
                delay,
                transpose,
                event.midi.length,
              ),
            );
            nextAudioEvent += 1;
          }
          if (metronome) {
            while (nextMetronomeBeat <= audioEndBeat) {
              const targetTime =
                audioStartTime +
                (nextMetronomeBeat - baseBeat) * beatSeconds;
              if (targetTime > horizon) break;
              synthRef.current.click(
                Math.abs(nextMetronomeBeat % score.beatsPerMeasure) < 0.001,
                Math.max(0, targetTime - schedulerNow),
                metronomeVolume,
              );
              nextMetronomeBeat += 1;
            }
          }
          if (
            audioScheduler !== null &&
            nextAudioEvent >= scheduled.length &&
            (!metronome || nextMetronomeBeat > audioEndBeat)
          ) {
            window.clearInterval(audioScheduler);
            audioScheduler = null;
          }
        };
        scheduleAudioWindow();
        audioScheduler = window.setInterval(scheduleAudioWindow, 50);
        timersRef.current.push(audioScheduler);
      }

      scheduled.forEach((event) => {
        const offset = (event.startBeat - baseBeat) * beatSeconds + countDelay;
        const timer = window.setTimeout(() => {
          const index = visibleEvents.findIndex((item) => item.id === event.id);
          if (index >= 0) {
            setCurrentEvent(index);
            setPosition((event.startBeat * 60) / (score.bpm * speed));
            advanceCursor(event.startBeat, event.measure);
            if (autoScrollRef.current) {
              window.requestAnimationFrame(() => {
                const scoreElement = scoreRef.current;
                if (!scoreElement || !score) return;
                const cursorMarker = scoreElement.querySelector<HTMLElement>(".playback-highlight");
                const noteY = Number(cursorMarker?.dataset.scrollY);
                const scrollArea = scoreElement.closest<HTMLElement>(".score-area");
                if (!scrollArea || !Number.isFinite(noteY)) return;
                const scoreRect = scoreElement.getBoundingClientRect();
                const areaRect = scrollArea.getBoundingClientRect();
                const noteViewportY = scoreRect.top - areaRect.top + noteY;
                const upperBound = scrollArea.clientHeight * 0.28;
                const lowerBound = scrollArea.clientHeight * 0.64;
                // .score-area is the element that scrolls, not the browser
                // window. Move only when the current note leaves its reading
                // zone, which prevents continuous jitter.
                if (noteViewportY < upperBound || noteViewportY > lowerBound) {
                  const target = scrollArea.scrollTop + noteViewportY - scrollArea.clientHeight * 0.44;
                  scrollArea.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
                }
              });
            }
          }
        }, offset * 1000);
        timersRef.current.push(timer);
      });

      const finishAfter = lastScheduled
        ? (lastScheduled.startBeat - baseBeat + lastScheduled.durationBeats) *
            beatSeconds +
          countDelay
        : beatSeconds;
      timersRef.current.push(
        window.setTimeout(() => {
          setPlaying(false);
          if (repeat) {
            const repeatIndex =
              mode === "fragment"
                ? visibleEvents.findIndex((event) => event.measure >= rangeStart)
                : mode === "measure"
                  ? startIndex
                  : 0;
            void scheduleRef.current(Math.max(0, repeatIndex), oneOnly);
          }
        }, finishAfter * 1000 + 30),
      );
    },
    [
      advanceCursor,
      clearTimers,
      countIn,
      metronome,
      metronomeVolume,
      mode,
      rangeEnd,
      rangeStart,
      repeat,
      score,
      speed,
      transpose,
      visibleEvents,
      volume,
    ],
  );

  useEffect(() => {
    scheduleRef.current = scheduleFrom;
  }, [scheduleFrom]);

  const togglePlay = useCallback(() => {
    if (trainingMode) {
      setKeyboardGuide(true);
      setTrainingAttempt({ eventId: active?.id || "", pressed: [], feedback: "В режиме обучения нажимайте клавиши текущего аккорда." });
      return;
    }
    if (playing) {
      stop(false);
    } else {
      void scheduleFrom(currentEvent);
    }
  }, [active?.id, currentEvent, playing, scheduleFrom, stop, trainingMode]);

  const moveEvent = useCallback(
    (delta: number) => {
      if (!visibleEvents.length) return;
      stop(false);
      let next = currentEvent + delta;
      if (mode === "measure") {
        const targetMeasure = Math.min(
          score?.measureCount || 1,
          Math.max(1, currentMeasure + delta),
        );
        next = visibleEvents.findIndex((event) => event.measure === targetMeasure);
      }
      next = Math.max(0, Math.min(visibleEvents.length - 1, next));
      setCurrentEvent(next);
      setPosition(
        score
          ? (visibleEvents[next].startBeat * 60) / (score.bpm * speed)
          : 0,
      );
      advanceCursor(visibleEvents[next].startBeat, visibleEvents[next].measure);
      if (mode === "event") void scheduleFrom(next, true);
    },
    [
      advanceCursor,
      currentEvent,
      currentMeasure,
      mode,
      scheduleFrom,
      score,
      speed,
      stop,
      visibleEvents,
    ],
  );

  const handleTrainingKey = useCallback((midi: number) => {
    if (!trainingMode || !activeChordKeys.length) return;
    const expected = activeChordKeys.map((key) => key.midi);
    const currentAttempt = trainingAttempt.eventId === active?.id
      ? trainingAttempt
      : { eventId: active?.id || "", pressed: [], feedback: "" };
    if (!expected.includes(midi)) {
      setTrainingAttempt({ ...currentAttempt, feedback: "Этой клавиши нет в текущем аккорде. Попробуйте ещё раз." });
      return;
    }
    const next = [...new Set([...currentAttempt.pressed, midi])];
    if (expected.every((note) => next.includes(note))) {
      setTrainingAttempt({ eventId: active?.id || "", pressed: next, feedback: "Верно! Следующий аккорд…" });
      window.setTimeout(() => moveEvent(1), 260);
    } else {
      setTrainingAttempt({ eventId: active?.id || "", pressed: next, feedback: "Верно. Добавьте остальные клавиши аккорда." });
    }
  }, [active?.id, activeChordKeys, moveEvent, trainingAttempt, trainingMode]);

  const openScoreEditor = useCallback(() => {
    if (!score) return;
    stop(false);
    const measure = active?.measure || 1;
    const partId = active?.partId || score.parts[0]?.id || "P1";
    const measureEvents = score.events
      .filter((event) => event.measure === measure && event.partId === partId && !event.isRest)
    const measureStart = measureEvents[0]?.measureStartBeat ?? Math.min(...measureEvents.map((event) => event.startBeat), 0);
    const beats = measureEvents[0]?.measureBeats || score.beatsPerMeasure;
    const notes = measureEvents
      .flatMap((event) => event.midi.map((midi, index) => ({
        id: `${event.id}-${index}`,
        midi,
        startBeat: event.startBeat - (event.measureStartBeat ?? measureStart),
        durationBeats: event.durationBeats,
        staff: event.staff,
        voice: event.voice,
        originalMidi: midi,
        originalStartBeat: event.startBeat - (event.measureStartBeat ?? measureStart),
      })));
    setEditorMeasure(measure);
    setEditorPartId(partId);
    setEditorNotes(notes);
    setEditorBeatsPerMeasure(beats);
    setSelectedEditorNote(notes[0]?.id || "");
    setEditorOpen(true);
  }, [active?.measure, active?.partId, score, stop]);

  const saveScoreEditor = useCallback(() => {
    if (!score) return;
    const updatedXml = score.sourceXml
      ? applyMeasureEditorToMusicXml(score.sourceXml, editorPartId, editorMeasure, editorNotes, editorBeatsPerMeasure)
      : undefined;
    const nextScore = updatedXml ? parseMusicXml(updatedXml) : score;
    setScore({ ...nextScore, title: score.title });
    const nextSaved = loadSaved().map((item) => item.fileName === fileName
      ? { ...item, xml: updatedXml || item.xml, savedAt: Date.now() }
      : item);
    localStorage.setItem("notera-scores", JSON.stringify(nextSaved));
    setSaved(nextSaved);
    setEditorOpen(false);
    setNotice(updatedXml
      ? "Изменения сохранены в MusicXML. Партитура и воспроизведение обновлены."
      : "Изменения такта сохранены для воспроизведения, клавиатуры и повторного открытия.");
  }, [editorBeatsPerMeasure, editorMeasure, editorNotes, editorPartId, fileName, score]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "ArrowRight") moveEvent(1);
      else if (event.key === "ArrowLeft") moveEvent(-1);
      else if (event.key.toLowerCase() === "r") setRepeat((value) => !value);
      else if (event.key.toLowerCase() === "m") setMetronome((value) => !value);
      else if (event.code === "KeyA") setAutoScroll((value) => !value);
      else if (event.code === "KeyK") setKeyboardGuide((value) => !value);
      else if (event.code === "KeyT") {
        stop(false);
        setMode((value) => value === "training" ? "continuous" : "training");
        setKeyboardGuide(true);
      }
      else if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moveEvent, stop, togglePlay]);

  useEffect(() => {
    if (!playing) return;
    const frame = window.setInterval(() => {
      const elapsed = (performance.now() - playStartedRef.current) / 1000;
      setPosition(Math.max(positionStartedRef.current, positionStartedRef.current + elapsed));
    }, 150);
    return () => window.clearInterval(frame);
  }, [playing]);

  const seek = (seconds: number) => {
    if (!score || !visibleEvents.length) return;
    stop(false);
    const targetBeat = (seconds * score.bpm * speed) / 60;
    let index = visibleEvents.findIndex((event) => event.startBeat >= targetBeat);
    if (index < 0) index = visibleEvents.length - 1;
    setCurrentEvent(index);
    setPosition(seconds);
    advanceCursor(
      visibleEvents[index].startBeat,
      visibleEvents[index].measure,
    );
  };

  const playFromScoreClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const container = scoreRef.current;
      if (!container || !score || !visibleEvents.length) return;
      const positions = scoreClickPositionsRef.current;
      if (!positions.length) return;
      const containerRect = container.getBoundingClientRect();
      const x =
        event.clientX - containerRect.left + container.scrollLeft;
      const y =
        event.clientY - containerRect.top + container.scrollTop;
      const sameSystem = positions.filter(
        (position) =>
          Math.abs(position.y - y) <= Math.max(38, position.height / 2 + 18),
      );
      const candidates = sameSystem.length ? sameSystem : positions;
      const nearest = candidates.reduce((best, position) => {
        const bestDistance =
          Math.abs(best.x - x) + Math.abs(best.y - y) * 4;
        const distance =
          Math.abs(position.x - x) + Math.abs(position.y - y) * 4;
        return distance < bestDistance ? position : best;
      });
      let index = visibleEvents.findIndex(
        (item) => item.startBeat >= nearest.beat - 0.0001,
      );
      if (index < 0) index = visibleEvents.length - 1;
      stop(false);
      setCurrentEvent(index);
      setPosition(
        (visibleEvents[index].startBeat * 60) / (score.bpm * speed),
      );
      advanceCursor(
        visibleEvents[index].startBeat,
        visibleEvents[index].measure,
      );
      if (playing) void scheduleFrom(index);
    },
    [advanceCursor, playing, scheduleFrom, score, speed, stop, visibleEvents],
  );

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void processFile(file);
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void processFile(file);
    event.target.value = "";
  };

  const removeSaved = (savedAt: number) => {
    const next = saved.filter((item) => item.savedAt !== savedAt);
    localStorage.setItem("notera-scores", JSON.stringify(next));
    setSaved(next);
  };

  const openSavedScore = (item: SavedScore) => {
    const data = parseMusicXml(item.xml);
    if (item.bpm) data.bpm = item.bpm;
    if (item.edits?.length) {
      const edits = new Map(item.edits.map((edit) => [edit.id, edit.midi]));
      const durations = new Map(item.edits.map((edit) => [edit.id, edit.durationBeats]));
      data.events = data.events.map((event) => edits.has(event.id)
        ? {
            ...event,
            midi: edits.get(event.id)!,
            durationBeats: durations.get(event.id) ?? event.durationBeats,
            names: edits.get(event.id)!.map((midi) => nameForMidi(midi, false)),
          }
        : event);
    }
    setLibraryOpen(false);
    openScore(data, item.fileName);
  };

  const editSavedMetadata = (item: SavedScore) => {
    setEditingSavedAt(item.savedAt);
    setLibraryTagsDraft(item.tags.join(", "));
    setLibraryNotesDraft(item.notes);
  };

  const saveSavedMetadata = () => {
    if (editingSavedAt === null) return;
    const tags = [...new Set(libraryTagsDraft.split(",").map((tag) => tag.trim()).filter(Boolean))];
    const next = saved.map((item) => item.savedAt === editingSavedAt
      ? { ...item, tags, notes: libraryNotesDraft.trim() }
      : item);
    localStorage.setItem("notera-scores", JSON.stringify(next));
    setSaved(next);
    setEditingSavedAt(null);
  };

  const exportXml = () => {
    if (!score?.sourceXml) return;
    const blob = new Blob([score.sourceXml], { type: "application/vnd.recordare.musicxml+xml" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${score.title}.musicxml`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  if (!score && omrJob) {
    const currentStageIndex = OMR_STAGES.findIndex(
      (item) => item.stage === omrJob.stage,
    );
    const failed = omrJob.stage === "error";
    const progress = Math.max(0, Math.min(100, omrJob.progress ?? (
      currentStageIndex < 0 ? 0 : Math.round((currentStageIndex / OMR_STAGES.length) * 100)
    )));
    return (
      <main className={`processing-page ${theme}`}>
        <header className="landing-header">
          <button className="brand" onClick={() => void cancelOmr()}>
            <span className="brand-mark">♪</span>
            <span>Нотера</span>
          </button>
          <span className="processing-file">{omrJob.file_name}</span>
        </header>
        <section className="processing-card">
          <div className={`processing-symbol ${failed ? "failed" : ""}`}>
            {failed ? "!" : "𝄞"}
          </div>
          <span className="eyebrow">
            {failed ? "Обработка остановлена" : "Распознавание PDF"}
          </span>
          <h1>{failed ? "Не удалось прочитать ноты" : "Превращаем PDF в партитуру"}</h1>
          <p className={failed ? "processing-error" : ""}>{omrJob.message}</p>

          {!failed && (
            <div className="processing-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              <div className="processing-progress-track"><i style={{ width: `${progress}%` }} /></div>
              <span>{progress}%</span>
            </div>
          )}

          {!failed && (
            <ol className="processing-steps">
              {OMR_STAGES.map((item, index) => (
                <li
                  key={item.stage}
                  className={
                    index < currentStageIndex
                      ? "done"
                      : index === currentStageIndex
                        ? "active"
                        : ""
                  }
                >
                  <span>{index < currentStageIndex ? "✓" : index + 1}</span>
                  <b>{item.label}</b>
                </li>
              ))}
            </ol>
          )}

          {omrJob.thumbnails.length > 0 && (
            <div className="page-thumbnails">
              {omrJob.thumbnails.map((source, index) => (
                <figure key={source}>
                  {/* Generated job images change while the API is polled; using a
                      plain image avoids caching an early 404 in an optimizer. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={source}
                    alt={`Страница ${index + 1}`}
                    width={320}
                    height={420}
                  />
                  <figcaption>{index + 1}</figcaption>
                </figure>
              ))}
              {(omrJob.page_count || 0) > 6 && (
                <div className="more-pages">+{(omrJob.page_count || 0) - 6}</div>
              )}
            </div>
          )}

          <div className="processing-actions">
            {failed && pendingPdf && (
              <button
                className="primary-button"
                onClick={() => void processPdf(pendingPdf)}
              >
                Запустить снова
              </button>
            )}
            <button className="ghost-button" onClick={() => void cancelOmr()}>
              {failed ? "Выбрать другой файл" : "Отменить обработку"}
            </button>
          </div>
          <small>
            Audiveris работает локально в Docker. Файл не передаётся сторонним
            сервисам.
          </small>
        </section>
      </main>
    );
  }

  if (libraryOpen) {
    return (
      <main className={`landing library-page ${theme}`} data-testid="library">
        <header className="landing-header">
          <button className="brand" onClick={() => setLibraryOpen(false)}>
            <span className="brand-mark">♪</span><span>Нотера</span>
          </button>
          <div className="header-actions">
            <button className="ghost-button" onClick={() => setLibraryOpen(false)}>← {score ? "К партитуре" : "На главную"}</button>
            <button className="icon-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label="Сменить тему">{theme === "light" ? "☾" : "☀"}</button>
          </div>
        </header>
        <section className="library-heading">
          <div><span className="eyebrow">Моя музыка</span><h1>Библиотека произведений</h1><p>Сохранённые партитуры остаются на этом устройстве. Добавляйте теги и заметки, чтобы быстро находить нужное.</p></div>
          <button className="primary-button" onClick={() => { setLibraryOpen(false); if (score) { stop(); setScore(null); } }}>Загрузить партитуру</button>
        </section>
        <section className="library-toolbar" aria-label="Поиск в библиотеке">
          <input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Поиск по названию, тегу или заметке" aria-label="Поиск" />
          <select value={libraryTag} onChange={(event) => setLibraryTag(event.target.value)} aria-label="Фильтр по тегу"><option value="">Все теги</option>{allLibraryTags.map((tag) => <option value={tag} key={tag}>{tag}</option>)}</select>
        </section>
        {allLibraryTags.length > 0 && <div className="tag-filter"><button className={!libraryTag ? "active" : ""} onClick={() => setLibraryTag("")}>Все</button>{allLibraryTags.map((tag) => <button className={libraryTag === tag ? "active" : ""} onClick={() => setLibraryTag(tag)} key={tag}>{tag}</button>)}</div>}
        <section className="library-list">
          {libraryItems.length ? libraryItems.map((item) => (
            <article className="library-card" key={item.savedAt}>
              <button className="library-open" onClick={() => openSavedScore(item)}><span className="sheet-thumb">𝄞</span><span><b>{item.name}</b><small>{item.fileName} · {new Date(item.savedAt).toLocaleDateString("ru-RU")}</small>{item.notes && <em>{item.notes}</em>}<span className="tag-row">{item.tags.length ? item.tags.map((tag) => <i key={tag}>{tag}</i>) : <i className="empty-tag">Без тегов</i>}</span></span></button>
              <div className="library-actions"><button className="ghost-button" onClick={() => editSavedMetadata(item)}>Изменить</button><button className="delete-button" onClick={() => removeSaved(item.savedAt)} aria-label={`Удалить ${item.name}`}>×</button></div>
              {editingSavedAt === item.savedAt && <div className="library-edit"><label>Теги через запятую<input value={libraryTagsDraft} onChange={(event) => setLibraryTagsDraft(event.target.value)} placeholder="например: разбор, классика" /></label><label>Заметка<textarea value={libraryNotesDraft} onChange={(event) => setLibraryNotesDraft(event.target.value)} placeholder="Что нужно повторить или исправить" /></label><div><button className="primary-button" onClick={saveSavedMetadata}>Сохранить</button><button className="ghost-button" onClick={() => setEditingSavedAt(null)}>Отменить</button></div></div>}
            </article>
          )) : <div className="library-empty"><b>{saved.length ? "Ничего не найдено" : "Библиотека пока пуста"}</b><span>{saved.length ? "Измените запрос или выбранный тег." : "Загрузите MusicXML, MIDI или PDF — партитура сохранится здесь после обработки."}</span></div>}
        </section>
      </main>
    );
  }

  if (!score) {
    return (
      <main className={`landing ${theme}`} data-testid="landing">
        <header className="landing-header">
          <a className="brand" href="#" aria-label="Нотера, на главную">
            <span className="brand-mark">♪</span>
            <span>Нотера</span>
          </a>
          <div className="header-actions"><button className="ghost-button" onClick={() => setLibraryOpen(true)}>Библиотека{saved.length ? ` · ${saved.length}` : ""}</button><button className="icon-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label="Сменить тему">{theme === "light" ? "☾" : "☀"}</button></div>
        </header>

        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">Тренажёр чтения с листа</span>
            <h1>Услышьте ноты.<br />Разберите их в своём темпе.</h1>
            <p>
              Загрузите партитуру, слушайте по нотам или тактам и следите за
              подсветкой в реальном времени.
            </p>
            <div className="feature-row">
              <span><b>01</b> Замедление без потери позиции</span>
              <span><b>02</b> Правая и левая рука отдельно</span>
              <span><b>03</b> Повтор сложного фрагмента</span>
            </div>
          </div>

          <div
            className={`upload-card ${dragging ? "is-dragging" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div className="upload-icon"><span>♫</span></div>
            <h2>{loading ? "Открываем партитуру…" : "Перетащите ноты сюда"}</h2>
            <p>PDF до 50 МБ · MusicXML, MXL или MIDI до 25 МБ</p>
            <label className="primary-button">
              <input type="file" accept=".musicxml,.xml,.mxl,.mid,.midi,.pdf" onChange={onFile} />
              Выбрать файл
            </label>
            <button className="text-button" onClick={() => void openDemo()} disabled={loading}>
              Открыть демонстрационное произведение →
            </button>
            {error && <div className="error-box" role="alert">{error}</div>}
          </div>
        </section>

        <section className="formats" aria-label="Поддерживаемые форматы">
          <span>Поддерживаемые форматы</span>
          <div><b>MusicXML</b><small>прямая загрузка</small></div>
          <div><b>MXL</b><small>сжатая партитура</small></div>
          <div><b>MIDI</b><small>временная шкала</small></div>
          <div><b>PDF</b><small>Audiveris OMR</small></div>
        </section>

        {saved.length > 0 && (
          <section className="recent">
            <div className="section-heading">
              <div><span className="eyebrow">Продолжить</span><h2>Последние произведения</h2></div>
              <span>{saved.length} сохранено на этом устройстве</span>
            </div>
            <div className="recent-grid">
              {saved.map((item) => (
                <article className="recent-card" key={item.savedAt}>
                  <button className="recent-open" onClick={() => openSavedScore(item)}>
                    <span className="sheet-thumb">𝄞</span>
                    <span><b>{item.name}</b><small>{new Date(item.savedAt).toLocaleDateString("ru-RU")}</small></span>
                  </button>
                  <button className="delete-button" onClick={() => removeSaved(item.savedAt)} aria-label={`Удалить ${item.name}`}>×</button>
                </article>
              ))}
            </div>
          </section>
        )}

        <footer className="landing-footer">
          <span>Нотера · локальная первая версия</span>
          <span>Ваши MusicXML-файлы не покидают браузер</span>
        </footer>
      </main>
    );
  }

  return (
    <main className={`workspace ${theme}`}>
      <header className="app-header">
        <button className="brand compact" onClick={() => { stop(); setScore(null); }}>
          <span className="brand-mark">♪</span><span>Нотера</span>
        </button>
        <div className="piece-title">
          <b>{score.title}</b>
          <span>{score.composer || fileName}</span>
        </div>
        <div className="header-actions">
          <button className="ghost-button" onClick={() => setLibraryOpen(true)}>Библиотека</button>
          {score.sourceXml && <button className="ghost-button" onClick={exportXml}>Экспорт MusicXML</button>}
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Настройки">⚙</button>
        </div>
      </header>

      {notice && <div className="notice-bar"><span>✓</span>{notice}<button onClick={() => setNotice("")}>×</button></div>}

      <section className="score-shell">
        <aside className="study-panel">
          <span className="panel-label">Режим занятия</span>
          {([
            ["continuous", "▶", "Всё произведение"],
            ["event", "♪", "По одной ноте"],
            ["measure", "▥", "По тактам"],
            ["fragment", "↔", "Фрагмент"],
            ["training", "⌨", "Режим обучения"],
          ] as const).map(([value, icon, label]) => (
            <button key={value} className={mode === value ? "active" : ""} onClick={() => { stop(false); setMode(value); if (value === "training") setKeyboardGuide(true); }}>
              <span>{icon}</span>{label}
            </button>
          ))}

          <span className="panel-label gap">Партии</span>
          {score.parts.map((part, index) => (
            <label className="part-toggle" key={part.id}>
              <input
                type="checkbox"
                checked={enabledParts.has(part.id)}
                onChange={() => {
                  const next = new Set(enabledParts);
                  if (next.has(part.id) && next.size > 1) next.delete(part.id);
                  else next.add(part.id);
                  setEnabledParts(next);
                }}
              />
              <span className={`part-dot color-${index % 3}`} />
              <span>{part.name}</span>
            </label>
          ))}

          {mode === "fragment" && (
            <div className="range-box">
              <label>От такта<input type="number" min={1} max={rangeEnd} value={rangeStart} onChange={(e) => setRangeStart(Math.max(1, Number(e.target.value)))} /></label>
              <label>До такта<input type="number" min={rangeStart} max={score.measureCount} value={rangeEnd} onChange={(e) => setRangeEnd(Math.min(score.measureCount, Number(e.target.value)))} /></label>
            </div>
          )}

          <div className="shortcut-card">
            <span>Быстрые клавиши</span>
            <p><kbd>Пробел</kbd> играть / пауза</p>
            <p><kbd>←</kbd><kbd>→</kbd> шаг назад / вперёд</p>
            <p><kbd>R</kbd> повтор · <kbd>M</kbd> метроном · <kbd>A</kbd> автопрокрутка · <kbd>K</kbd> клавиатура · <kbd>T</kbd> обучение</p>
          </div>
        </aside>

        <div className="score-area">
          <div className="score-toolbar">
            <div><span className="status-dot" />Такт {currentMeasure} из {score.measureCount}</div>
            <div className="zoom-note">
              {score.sourceXml && "Нажмите на ноты, чтобы играть отсюда · "}
              {Math.round(score.bpm * speed)} BPM
            </div>
          </div>
          {score.sourceXml ? (
            <div
              className="paper"
              ref={scoreRef}
              aria-label="Партитура — нажмите на ноты, чтобы играть с этого места"
              title="Нажмите на нужное место, чтобы начать воспроизведение"
              onClick={playFromScoreClick}
            />
          ) : (
            <div className="paper piano-roll">
              <div className="roll-heading"><b>Временная шкала MIDI</b><span>Нажмите событие, чтобы перейти к нему</span></div>
              {Array.from({ length: score.measureCount }, (_, measureIndex) => {
                const measure = measureIndex + 1;
                const measureEvents = visibleEvents.filter((event) => event.measure === measure);
                return (
                  <button
                    className={`roll-measure ${measure === currentMeasure ? "current" : ""}`}
                    key={measure}
                    onClick={() => {
                      const index = visibleEvents.findIndex((event) => event.measure === measure);
                      if (index >= 0) { setCurrentEvent(index); seek((visibleEvents[index].startBeat * 60) / (score.bpm * speed)); }
                    }}
                  >
                    <span className="measure-number">{measure}</span>
                    <span className="roll-notes">
                      {measureEvents.map((event) => (
                        <i
                          key={event.id}
                          style={{
                            left: `${((event.startBeat % score.beatsPerMeasure) / score.beatsPerMeasure) * 100}%`,
                            width: `${Math.max(3, (event.durationBeats / score.beatsPerMeasure) * 100)}%`,
                            bottom: `${Math.max(4, Math.min(88, ((event.midi[0] || 48) - 36) * 1.6))}%`,
                          }}
                        />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {showNames && active && !active.isRest && (
            <div className="now-playing-note">
              Сейчас: {active.midi.map((midi) => nameForMidi(midi + transpose, solfege)).join(" · ")}
            </div>
          )}
        </div>
      </section>

      <section className={`transport ${(keyboardGuide || trainingMode) ? "with-keyboard" : ""}`} aria-label="Управление воспроизведением">
        <div className="transport-main">
          <button className="control-button" onClick={() => moveEvent(-1)} aria-label="Предыдущее событие"><Icon>‹</Icon></button>
          <button className="play-button" onClick={togglePlay} aria-label={playing ? "Пауза" : "Воспроизвести"}>{playing ? "Ⅱ" : "▶"}</button>
          <button className="control-button" onClick={() => stop()} aria-label="Остановить">■</button>
          <button className="control-button" onClick={() => moveEvent(1)} aria-label="Следующее событие"><Icon>›</Icon></button>
          {(mode === "event" || trainingMode) && <button className="next-event-button" onClick={() => moveEvent(1)}>Следующая нота</button>}
        </div>
        <div className="timeline">
          <span>{formatTime(position)}</span>
          <input
            aria-label="Позиция"
            type="range"
            min={0}
            max={Math.max(0.1, totalDuration)}
            step={0.01}
            value={Math.min(position, totalDuration)}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span>{formatTime(totalDuration)}</span>
        </div>
        <div className="transport-options">
          <label className="select-control">
            <span>Темп, BPM</span>
            <input
              aria-label="Темп в ударах в минуту"
              type="number"
              min={20}
              max={400}
              step={1}
              value={tempoInput}
              onChange={(event) => setTempoInput(event.target.value)}
              onBlur={() => {
                const bpm = Number(tempoInput);
                if (!Number.isFinite(bpm) || bpm <= 0) {
                  setTempoInput(String(Math.round(score.bpm * speed)));
                  return;
                }
                const clamped = Math.max(20, Math.min(400, Math.round(bpm)));
                stop(false);
                setTempoInput(String(clamped));
                setSpeed(clamped / score.bpm);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
          <label className="volume-control"><span>Громкость</span><input type="range" min={0} max={1} step={0.01} value={volume} onChange={(event) => { const value = Number(event.target.value); setVolume(value); synthRef.current.setVolume(value); }} /></label>
          <button className={`toggle-button ${metronome ? "on" : ""}`} onClick={() => setMetronome(!metronome)}><span>♩</span> Метроном</button>
          <button className={`toggle-button ${repeat ? "on" : ""}`} onClick={() => setRepeat(!repeat)}><span>↻</span> Повтор</button>
          <button className="toggle-button" onClick={openScoreEditor}>✎ Редактор</button>
        </div>
        {(keyboardGuide || trainingMode) && (
          <div className="keyboard-guide-wrap">
            {trainingMode && <p className="training-status">{trainingFeedback || "Нажмите все клавиши показанного аккорда."}</p>}
            <PianoKeyboard keys={activeChordKeys} pressedNotes={trainingMode ? trainingPressed : []} onKeyPress={trainingMode ? handleTrainingKey : undefined} />
          </div>
        )}
      </section>

      {editorOpen && (
        <div className="modal-backdrop editor-backdrop" onMouseDown={() => setEditorOpen(false)}>
          <section className="score-editor" role="dialog" aria-modal="true" aria-labelledby="editor-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="eyebrow">Ручное исправление</span><h2 id="editor-title">Редактор такта {editorMeasure}</h2></div>
              <button onClick={() => setEditorOpen(false)} aria-label="Закрыть редактор">×</button>
            </div>
            <p className="editor-help">Это редактируемая строка партитуры. Потяните ноту по вертикали или горизонтали; щёлкните по пустому месту, чтобы добавить ноту. Выберите ноту для изменения её длительности или удаления.</p>
            <div className="editor-toolbar">
              <span>Длительность новой/выбранной ноты:</span>
              {[0.25, 0.5, 1, 2, 4].map((duration) => (
                <button key={duration} type="button" className={editorNotes.find((note) => note.id === selectedEditorNote)?.durationBeats === duration ? "active" : ""} onClick={() => setEditorNotes((notes) => notes.map((note) => note.id === selectedEditorNote ? { ...note, durationBeats: duration } : note))}>
                  {{ 0.25: "16", 0.5: "⅛", 1: "¼", 2: "½", 4: "1" }[duration]}
                </button>
              ))}
              <button type="button" className="editor-delete" disabled={!selectedEditorNote} onClick={() => { setEditorNotes((notes) => notes.filter((note) => note.id !== selectedEditorNote)); setSelectedEditorNote(""); }}>Удалить</button>
            </div>
            <div
              className="score-editor-staff"
              onPointerDown={(event) => {
                if (!score || event.target !== event.currentTarget) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const staff = event.clientY - rect.top < rect.height / 2 ? 1 : 2;
                const relativePercent = ((event.clientY - rect.top) / rect.height) * 100;
                const center = staff === 1 ? 25 : 75;
                const centerStep = staff === 1 ? diatonicStepForMidi(71) : diatonicStepForMidi(50);
                const midi = Math.max(21, Math.min(108, midiForDiatonicStep(centerStep + Math.round((center - relativePercent) / 2.63))));
                const timelinePercent = ((event.clientX - rect.left) / rect.width) * 100;
                const startBeat = Math.max(0, Math.min(editorBeatsPerMeasure - 0.25, Math.round(((timelinePercent - editorTimelineStart) / editorTimelineWidth) * editorBeatsPerMeasure * 4) / 4));
                const note = { id: `new-${Date.now()}`, midi, startBeat, durationBeats: 1, staff, voice: "1" };
                setEditorNotes((notes) => [...notes, note]);
                setSelectedEditorNote(note.id);
              }}
              onPointerMove={(event) => {
                if (!editorDrag || !score) return;
                const steps = Math.round((editorDrag.startY - event.clientY) / (event.currentTarget.getBoundingClientRect().height * 0.0263));
                const deltaBeats = Math.round((((event.clientX - editorDrag.startX) / editorDrag.rollWidth) * editorBeatsPerMeasure / (editorTimelineWidth / 100)) * 4) / 4;
                setEditorNotes((notes) => notes.map((note) => note.id === editorDrag.noteId ? { ...note, midi: Math.max(21, Math.min(108, midiForDiatonicStep(diatonicStepForMidi(editorDrag.midi) + steps))), startBeat: Math.max(0, Math.min(editorBeatsPerMeasure - 0.25, editorDrag.startBeat + deltaBeats)) } : note));
              }}
              onPointerUp={() => setEditorDrag(null)}
              onPointerCancel={() => setEditorDrag(null)}
            >
              <div className="editor-clef treble">𝄞</div><div className="editor-clef bass">𝄢</div>
              {[0, 1].map((staff) => <div className={`editor-staff-lines staff-${staff + 1}`} key={staff}>{Array.from({ length: 5 }, (_, line) => <i key={line} />)}</div>)}
              {Array.from({ length: editorBeatsPerMeasure + 1 }, (_, beat) => <i className="editor-beat-line" style={{ left: `${editorNoteLeft(beat, editorBeatsPerMeasure)}%` }} key={beat} />)}
              {editorNotes.map((note) => {
                const top = editorNoteTop(note.midi, note.staff);
                const left = editorNoteLeft(note.startBeat, editorBeatsPerMeasure);
                const originTop = note.originalMidi === undefined ? top : editorNoteTop(note.originalMidi, note.staff);
                const originLeft = editorNoteLeft(note.originalStartBeat ?? note.startBeat, editorBeatsPerMeasure);
                const moved = note.originalMidi !== undefined && (note.originalMidi !== note.midi || note.originalStartBeat !== note.startBeat);
                const durationKind = note.durationBeats >= 4 ? "whole" : note.durationBeats >= 2 ? "half" : note.durationBeats >= 1 ? "quarter" : note.durationBeats >= 0.5 ? "eighth" : "sixteenth";
                const step = diatonicStepForMidi(note.midi);
                const chord = editorNotes
                  .filter((candidate) => candidate.staff === note.staff && Math.abs(candidate.startBeat - note.startBeat) < 0.001)
                  .sort((a, b) => diatonicStepForMidi(a.midi) - diatonicStepForMidi(b.midi));
                const chordIndex = chord.findIndex((candidate) => candidate.id === note.id);
                const offset = chordIndex > 0 && diatonicStepForMidi(chord[chordIndex - 1].midi) >= step - 1 ? 13 : 0;
                const outsideStaff = Math.abs(step - (note.staff === 1 ? diatonicStepForMidi(71) : diatonicStepForMidi(50))) > 4;
                return (
                  <div key={note.id}>
                    {editorLedgerTops(note.midi, note.staff).map((ledgerTop) => <i className="editor-ledger-line" style={{ top: `${ledgerTop}%`, left: `calc(${left}% + ${offset}px)` }} key={ledgerTop} />)}
                    {moved && <span className="editor-note-origin" style={{ top: `${originTop}%`, left: `${originLeft}%` }} aria-label="Исходное положение ноты"><i /></span>}
                    <button
                      type="button"
                      className={`editor-note staff-${note.staff} ${selectedEditorNote === note.id ? "selected" : ""}`}
                      key={note.id}
                      style={{ top: `${top}%`, left: `calc(${left}% + ${offset}px)` }}
                      title={`${nameForMidi(note.midi, true)} · ${notationForBeats(note.durationBeats)[1]}`}
                      onPointerDown={(pointerEvent) => {
                        const roll = pointerEvent.currentTarget.closest<HTMLElement>(".score-editor-staff");
                        if (!roll || !score) return;
                        pointerEvent.stopPropagation();
                        pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
                        setSelectedEditorNote(note.id);
                        setEditorDrag({ noteId: note.id, startX: pointerEvent.clientX, startY: pointerEvent.clientY, midi: note.midi, startBeat: note.startBeat, staff: note.staff, rollWidth: roll.getBoundingClientRect().width });
                      }}
                    >
                      <span className={`editor-note-symbol ${durationKind}`}><i className="editor-notehead" /><i className="editor-stem" /><i className="editor-flag" /></span>
                    </button>
                    {outsideStaff && <span className="editor-note-label" style={{ top: `${top}%`, left: `calc(${left}% + ${offset + 18}px)` }}>{nameForMidi(note.midi, true)}</span>}
                  </div>
                );
              })}
            </div>
            <div className="editor-actions">
              <button className="ghost-button" onClick={() => setEditorOpen(false)}>Отменить</button>
              <button className="primary-button" onClick={saveScoreEditor}>Сохранить изменения</button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading"><div><span className="eyebrow">Параметры</span><h2 id="settings-title">Настройки занятия</h2></div><button onClick={() => setSettingsOpen(false)}>×</button></div>
            <div className="settings-grid">
              <label><span>Инструмент</span><select defaultValue="piano"><option value="piano">Мягкое фортепиано</option></select></label>
              <label><span>Отсчёт перед началом</span><select value={countIn} onChange={(e) => setCountIn(Number(e.target.value))}><option value={0}>Без отсчёта</option><option value={2}>2 доли</option><option value={4}>4 доли</option></select></label>
              <label><span>Транспонирование</span><select value={transpose} onChange={(e) => setTranspose(Number(e.target.value))}>{Array.from({ length: 25 }, (_, i) => i - 12).map((value) => <option value={value} key={value}>{value > 0 ? `+${value}` : value} полутонов</option>)}</select></label>
              <label><span>Громкость метронома</span><input type="range" min={0} max={1} step={0.05} value={metronomeVolume} onChange={(e) => setMetronomeVolume(Number(e.target.value))} /></label>
            </div>
            <div className="settings-toggles">
              <label><input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /><span><b>Автоматическая прокрутка <kbd>A</kbd></b><small>Удерживать текущую позицию в поле зрения</small></span></label>
              <label><input type="checkbox" checked={keyboardGuide} onChange={(e) => setKeyboardGuide(e.target.checked)} /><span><b>Клавиатура фортепиано <kbd>K</kbd></b><small>Показывать клавиши всех нот текущего аккорда</small></span></label>
              <label><input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} /><span><b>Показывать названия нот</b><small>Отображать звучащий аккорд под партитурой</small></span></label>
              <label><input type="checkbox" checked={solfege} onChange={(e) => setSolfege(e.target.checked)} /><span><b>Названия до–ре–ми</b><small>Выключите для обозначений C–D–E</small></span></label>
              <label><input type="checkbox" checked={theme === "dark"} onChange={(e) => { const value = e.target.checked ? "dark" : "light"; setTheme(value); localStorage.setItem("notera-theme", value); }} /><span><b>Тёмная тема</b><small>Снизить яркость интерфейса</small></span></label>
            </div>
            <button className="primary-button modal-save" onClick={() => setSettingsOpen(false)}>Готово</button>
          </section>
        </div>
      )}
    </main>
  );
}
