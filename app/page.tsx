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

type Mode = "continuous" | "event" | "measure" | "fragment";
type SavedScore = { name: string; xml: string; savedAt: number };
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

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
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
    return JSON.parse(localStorage.getItem("notera-scores") || "[]");
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
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [currentEvent, setCurrentEvent] = useState(0);
  const [speed, setSpeed] = useState(1);
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
  const [autoScroll, setAutoScroll] = useState(true);
  const [countIn, setCountIn] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [omrJob, setOmrJob] = useState<OmrJob | null>(null);
  const [pendingPdf, setPendingPdf] = useState<File | null>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OsmdInstance | null>(null);
  const scoreClickPositionsRef = useRef<ScoreClickPosition[]>([]);
  const cursorBeatRef = useRef(0);
  const highlightedNotesRef = useRef<GraphicalNoteLike[]>([]);
  const synthRef = useRef(new PianoSynth());
  const timersRef = useRef<number[]>([]);
  const playStartedRef = useRef(0);
  const positionStartedRef = useRef(0);
  const scheduleRef = useRef<
    (startIndex: number, oneOnly?: boolean) => Promise<void>
  >(() => Promise.resolve());

  useEffect(() => {
    void synthRef.current.preload().catch(() => {});
    const timer = window.setTimeout(() => {
      setSaved(loadSaved());
      const storedTheme = localStorage.getItem("notera-theme");
      if (storedTheme === "dark") setTheme("dark");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const visibleEvents = useMemo(() => {
    if (!score) return [];
    const from = mode === "fragment" ? rangeStart : 1;
    const to = mode === "fragment" ? rangeEnd : score.measureCount;
    return eventsInRange(score, from, to, enabledParts);
  }, [score, enabledParts, mode, rangeStart, rangeEnd]);

  const totalDuration = score ? scoreDuration(score, speed) : 0;
  const active = visibleEvents[currentEvent] || null;
  const currentMeasure = active?.measure || 1;

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

  const collectScoreClickPositions = useCallback((cursor: OsmdCursor) => {
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
        positions.push({
          beat: cursorBeat(cursor),
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
        const osmd = new OpenSheetMusicDisplay(scoreRef.current, {
          autoResize: true,
          backend: "svg",
          drawTitle: false,
          drawingParameters: "compacttight",
          followCursor: true,
          cursorsOptions: [
            {
              type: 4,
              color: "#2f6b57",
              alpha: 0.16,
              follow: true,
            },
          ],
        });
        await osmd.load(data.sourceXml);
        osmd.render();
        osmdRef.current = osmd;
        collectScoreClickPositions(osmd.cursor);
      } catch (caught) {
        console.error("OSMD render failed", caught);
      }
    },
    [collectScoreClickPositions],
  );

  useEffect(() => {
    if (score) void renderScore(score);
  }, [score, renderScore]);

  const openScore = useCallback((data: ScoreData, sourceName: string) => {
    stop();
    setScore(data);
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
        result_url: null,
        thumbnails: [],
      });
      try {
        const form = new FormData();
        form.append("file", file);
        const upload = await fetch("/api/omr/jobs", {
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
          const statusResponse = await fetch(`/api/omr/jobs/${job.id}`, {
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
        const result = await fetch(job.result_url, { cache: "no-store" });
        if (!result.ok) throw new Error("Не удалось получить готовый MusicXML.");
        const xml = await result.text();
        const data = parseMusicXml(xml);
        openScore(data, file.name);
        setNotice(
          "PDF распознан автоматически. Результат может содержать ошибки — проверьте высоту и длительность нот.",
        );
        const entry = { name: data.title, xml, savedAt: Date.now() };
        const next = [
          entry,
          ...loadSaved().filter((item) => item.name !== data.title),
        ].slice(0, 5);
        localStorage.setItem("notera-scores", JSON.stringify(next));
        setSaved(next);
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
            message.includes("<!DOCTYPE") || message.includes("Unexpected token")
              ? "OMR-сервис недоступен. Запустите приложение через Docker Compose."
              : message,
          page_count: current?.page_count || null,
          result_url: null,
          thumbnails: current?.thumbnails || [],
        }));
      }
    },
    [openScore],
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
        const entry = { name: data.title, xml, savedAt: Date.now() };
        const next = [entry, ...loadSaved().filter((item) => item.name !== data.title)].slice(0, 5);
        localStorage.setItem("notera-scores", JSON.stringify(next));
        setSaved(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Не удалось открыть файл.");
      } finally {
        setLoading(false);
      }
    },
    [openScore, processPdf],
  );

  const cancelOmr = async () => {
    const current = omrJob;
    if (current?.id) {
      try {
        const response = await fetch(`/api/omr/jobs/${current.id}`, {
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

  const advanceCursor = useCallback((targetBeat: number) => {
    const cursor = osmdRef.current?.cursor;
    if (!cursor) return;
    try {
      if (targetBeat + 0.0001 < cursorBeatRef.current) {
        cursor.reset();
        cursorBeatRef.current = 0;
      }
      let guard = 0;
      while (cursorBeat(cursor) + 0.0001 < targetBeat && guard < 10000) {
        const iterator = cursor.Iterator || cursor.iterator;
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
      const positions = scoreClickPositionsRef.current;
      const position = positions.reduce(
        (nearest, candidate) =>
          Math.abs(candidate.beat - targetBeat) <
          Math.abs(nearest.beat - targetBeat)
            ? candidate
            : nearest,
        positions[0],
      );
      const highlight =
        scoreRef.current?.querySelector<HTMLElement>(".playback-highlight");
      if (highlight && position) {
        const width = Math.max(22, Math.min(52, position.height * 0.15));
        highlight.hidden = false;
        highlight.style.left = `${position.x - width / 2}px`;
        highlight.style.top = `${position.y - position.height / 2}px`;
        highlight.style.width = `${width}px`;
        highlight.style.height = `${position.height}px`;
      }
    } catch {}
  }, []);

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

      setPlaying(true);
      setCurrentEvent(startIndex);
      playStartedRef.current = performance.now() + countDelay * 1000;
      positionStartedRef.current = (baseBeat * 60) / (score.bpm * speed);

      if (countIn > 0) {
        for (let beat = 0; beat < countIn; beat += 1) {
          synthRef.current.click(beat === 0, beat * beatSeconds, metronomeVolume);
        }
      }

      const audioStartTime = synthRef.current.currentTime() + countDelay;
      let nextAudioEvent = 0;
      let nextMetronomeBeat = Math.ceil(baseBeat - 0.0001);
      let audioScheduler: number | null = null;
      const lastScheduled = scheduled[scheduled.length - 1];
      const audioEndBeat = lastScheduled
        ? lastScheduled.startBeat + lastScheduled.durationBeats
        : baseBeat + 1;
      const scheduleAudioWindow = () => {
        const schedulerNow = synthRef.current.currentTime();
        const horizon = schedulerNow + 3;
        while (nextAudioEvent < scheduled.length) {
          const event = scheduled[nextAudioEvent];
          const targetTime =
            audioStartTime + (event.startBeat - baseBeat) * beatSeconds;
          if (targetTime > horizon) break;
          const delay = Math.max(0, targetTime - schedulerNow);
          event.midi.forEach((midi) =>
            synthRef.current.note(
              midi,
              durationSeconds(event, score.bpm, speed),
              delay,
              transpose,
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

      scheduled.forEach((event) => {
        const offset = (event.startBeat - baseBeat) * beatSeconds + countDelay;
        const timer = window.setTimeout(() => {
          const index = visibleEvents.findIndex((item) => item.id === event.id);
          if (index >= 0) {
            setCurrentEvent(index);
            setPosition((event.startBeat * 60) / (score.bpm * speed));
            advanceCursor(event.startBeat);
            if (autoScroll) {
              scoreRef.current
                ?.querySelector(".osmd-cursor")
                ?.scrollIntoView({ block: "center", behavior: "smooth" });
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
      autoScroll,
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
    if (playing) {
      stop(false);
    } else {
      void scheduleFrom(currentEvent);
    }
  }, [currentEvent, playing, scheduleFrom, stop]);

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
      advanceCursor(visibleEvents[next].startBeat);
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
      else if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moveEvent, togglePlay]);

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
    advanceCursor(visibleEvents[index].startBeat);
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
      advanceCursor(visibleEvents[index].startBeat);
      void scheduleFrom(index);
    },
    [advanceCursor, scheduleFrom, score, speed, stop, visibleEvents],
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

  if (!score) {
    return (
      <main className={`landing ${theme}`} data-testid="landing">
        <header className="landing-header">
          <a className="brand" href="#" aria-label="Нотера, на главную">
            <span className="brand-mark">♪</span>
            <span>Нотера</span>
          </a>
          <button className="icon-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label="Сменить тему">
            {theme === "light" ? "☾" : "☀"}
          </button>
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
                  <button className="recent-open" onClick={() => openScore(parseMusicXml(item.xml), `${item.name}.musicxml`)}>
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
          ] as const).map(([value, icon, label]) => (
            <button key={value} className={mode === value ? "active" : ""} onClick={() => { stop(false); setMode(value); }}>
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
            <p><kbd>R</kbd> повтор · <kbd>M</kbd> метроном</p>
          </div>
        </aside>

        <div className="score-area">
          <div className="score-toolbar">
            <div><span className="status-dot" />Такт {currentMeasure} из {score.measureCount}</div>
            <div className="zoom-note">
              {score.sourceXml && "Нажмите на ноты, чтобы играть отсюда · "}
              {score.bpm} BPM
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

      <section className="transport" aria-label="Управление воспроизведением">
        <div className="transport-main">
          <button className="control-button" onClick={() => moveEvent(-1)} aria-label="Предыдущее событие"><Icon>‹</Icon></button>
          <button className="play-button" onClick={togglePlay} aria-label={playing ? "Пауза" : "Воспроизвести"}>{playing ? "Ⅱ" : "▶"}</button>
          <button className="control-button" onClick={() => stop()} aria-label="Остановить">■</button>
          <button className="control-button" onClick={() => moveEvent(1)} aria-label="Следующее событие"><Icon>›</Icon></button>
          {mode === "event" && <button className="next-event-button" onClick={() => moveEvent(1)}>Следующая нота</button>}
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
          <label className="select-control"><span>Скорость</span><select value={speed} onChange={(event) => { stop(false); setSpeed(Number(event.target.value)); }}>
            {SPEEDS.map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
          </select></label>
          <label className="volume-control"><span>Громкость</span><input type="range" min={0} max={1} step={0.01} value={volume} onChange={(event) => { const value = Number(event.target.value); setVolume(value); synthRef.current.setVolume(value); }} /></label>
          <button className={`toggle-button ${metronome ? "on" : ""}`} onClick={() => setMetronome(!metronome)}><span>♩</span> Метроном</button>
          <button className={`toggle-button ${repeat ? "on" : ""}`} onClick={() => setRepeat(!repeat)}><span>↻</span> Повтор</button>
        </div>
      </section>

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
              <label><input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /><span><b>Автоматическая прокрутка</b><small>Удерживать текущую позицию в поле зрения</small></span></label>
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
