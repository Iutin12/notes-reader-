const PIANO_SAMPLES = [
  ["A0", 21], ["C1", 24], ["Ds1", 27], ["Fs1", 30],
  ["A1", 33], ["C2", 36], ["Ds2", 39], ["Fs2", 42],
  ["A2", 45], ["C3", 48], ["Ds3", 51], ["Fs3", 54],
  ["A3", 57], ["C4", 60], ["Ds4", 63], ["Fs4", 66],
  ["A4", 69], ["C5", 72], ["Ds5", 75], ["Fs5", 78],
  ["A5", 81], ["C6", 84], ["Ds6", 87], ["Fs6", 90],
  ["A6", 93], ["C7", 96], ["Ds7", 99], ["Fs7", 102],
  ["A7", 105], ["C8", 108],
] as const;

export type RenderedPianoNote = {
  midi: number;
  offset: number;
  duration: number;
  transpose: number;
  polyphony: number;
};

export class PianoSynth {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private active = new Set<AudioScheduledSourceNode>();
  private nativeActive = new Set<HTMLAudioElement>();
  private nativeObjectUrls = new Map<HTMLAudioElement, string>();
  private nativeTimers = new Set<number>();
  private nativeSamples = new Map<number, HTMLAudioElement>();
  private playbackGeneration = 0;
  private samples = new Map<number, AudioBuffer>();
  private loadingSamples: Promise<void> | null = null;
  private volume = 0.7;

  private useNativeAudio() {
    return (
      typeof navigator !== "undefined" &&
      /safari/i.test(navigator.userAgent) &&
      !/chrome|chromium|android/i.test(navigator.userAgent)
    );
  }

  private prepareNativeSamples() {
    if (typeof Audio === "undefined" || this.nativeSamples.size > 0) return;
    PIANO_SAMPLES.forEach(([name, midi]) => {
      const audio = new Audio(`/audio/piano/${name}.mp3`);
      audio.preload = "auto";
      audio.load();
      this.nativeSamples.set(midi, audio);
    });
  }

  private ensureContext() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.compressor = this.context.createDynamicsCompressor();
      this.compressor.threshold.value = -18;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 5;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.22;
      this.master.gain.value = this.volume * 0.78;
      this.master.connect(this.compressor);
      this.compressor.connect(this.context.destination);
    }
    return this.context;
  }

  preload() {
    if (this.useNativeAudio()) {
      this.prepareNativeSamples();
      this.ensureContext();
      return this.loadSamples();
    }
    this.ensureContext();
    return this.loadSamples();
  }

  async resume() {
    if (this.useNativeAudio()) {
      this.prepareNativeSamples();
      const sample = this.nativeSamples.get(60);
      if (!sample) throw new Error("Не удалось подготовить звук для Safari.");
      sample.volume = 0.0001;
      sample.currentTime = 0;
      await sample.play();
      sample.pause();
      sample.currentTime = 0;
      await this.loadSamples();
      return this.ensureContext();
    }
    const context = this.ensureContext();
    // Safari and some Chromium configurations only allow resume() while the
    // original click is still active. Do this before any network/decode await.
    if (context.state !== "running") await context.resume();

    // Start a silent source during the original user gesture. Some browsers
    // accept resume() but suspend the context again if no source was started.
    const unlock = context.createOscillator();
    const unlockGain = context.createGain();
    unlockGain.gain.value = 0.000001;
    unlock.connect(unlockGain);
    unlockGain.connect(context.destination);
    unlock.start();
    unlock.stop(context.currentTime + 0.02);

    await this.loadSamples();
    if (context.state !== "running") await context.resume();
    return context;
  }

  currentTime() {
    if (this.useNativeAudio()) return performance.now() / 1000;
    return this.context?.currentTime ?? 0;
  }

  isNativePlayback() {
    return this.useNativeAudio();
  }

  async playRendered(
    notes: RenderedPianoNote[],
    totalDuration: number,
    leadingSilence = 0,
  ) {
    if (!this.useNativeAudio() || this.samples.size === 0) return;
    const generation = ++this.playbackGeneration;
    const chunkDuration = 20;
    const timelineDuration = leadingSilence + totalDuration;
    const first = await this.renderChunk(
      notes,
      0,
      Math.min(chunkDuration, timelineDuration),
      leadingSilence,
    );
    if (generation !== this.playbackGeneration) {
      URL.revokeObjectURL(first.url);
      return;
    }
    await this.startRenderedChunk(
      first,
      notes,
      chunkDuration,
      timelineDuration,
      leadingSilence,
      generation,
    );
  }

  private async startRenderedChunk(
    chunk: { audio: HTMLAudioElement; url: string; span: number },
    notes: RenderedPianoNote[],
    nextStart: number,
    timelineDuration: number,
    leadingSilence: number,
    generation: number,
  ) {
    const { audio, url, span } = chunk;
    this.nativeActive.add(audio);
    this.nativeObjectUrls.set(audio, url);
    const cleanup = () => {
      this.nativeActive.delete(audio);
      this.nativeObjectUrls.delete(audio);
      URL.revokeObjectURL(url);
    };
    audio.addEventListener("ended", cleanup, { once: true });
    try {
      await audio.play();
    } catch (error) {
      cleanup();
      throw error;
    }
    if (nextStart >= timelineDuration) return;

    const nextSpan = Math.min(20, timelineDuration - nextStart);
    const nextChunk = this.renderChunk(
      notes,
      nextStart,
      nextSpan,
      leadingSilence,
    );
    const timer = window.setTimeout(async () => {
      this.nativeTimers.delete(timer);
      const rendered = await nextChunk;
      if (generation !== this.playbackGeneration) {
        URL.revokeObjectURL(rendered.url);
        return;
      }
      await this.startRenderedChunk(
        rendered,
        notes,
        nextStart + nextSpan,
        timelineDuration,
        leadingSilence,
        generation,
      );
    }, span * 1000);
    this.nativeTimers.add(timer);
  }

  private async renderChunk(
    notes: RenderedPianoNote[],
    chunkStart: number,
    chunkSpan: number,
    leadingSilence: number,
  ) {
    const sampleRate = 44100;
    // Safari plays a long score as consecutive rendered chunks. Keep enough
    // overlap after this chunk for a whole/half note that starts at its end;
    // otherwise the sound is cut at the fixed 2.2-second tail.
    const tail = Math.min(
      15,
      Math.max(
        2.2,
        ...notes
          .filter((note) => {
            const start = leadingSilence + note.offset;
            return start >= chunkStart && start < chunkStart + chunkSpan;
          })
          .map((note) => note.duration + 1.45),
      ),
    );
    const length = Math.max(
      1,
      Math.ceil((chunkSpan + tail) * sampleRate),
    );
    const offline = new OfflineAudioContext(1, length, sampleRate);
    const master = offline.createGain();
    const compressor = offline.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 20;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.3;
    master.gain.value = this.volume * 0.72;
    master.connect(compressor);
    compressor.connect(offline.destination);

    notes.forEach((note) => {
      const absoluteStart = leadingSilence + note.offset;
      if (
        absoluteStart < chunkStart ||
        absoluteStart >= chunkStart + chunkSpan
      ) {
        return;
      }
      const targetMidi = note.midi + note.transpose;
      const sampleMidi = PIANO_SAMPLES.reduce((nearest, candidate) =>
        Math.abs(candidate[1] - targetMidi) <
        Math.abs(nearest[1] - targetMidi)
          ? candidate
          : nearest,
      )[1];
      const buffer = this.samples.get(sampleMidi);
      if (!buffer) return;
      const start = absoluteStart - chunkStart;
      const noteEnd = start + Math.max(0.08, note.duration);
      const releaseEnd = Math.min(
        length / sampleRate - 0.02,
        noteEnd + 1.45,
      );
      const source = offline.createBufferSource();
      const gain = offline.createGain();
      source.buffer = buffer;
      source.playbackRate.value = 2 ** ((targetMidi - sampleMidi) / 12);
      const level = 0.58 / Math.sqrt(Math.max(1, note.polyphony));
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(level, start + 0.006);
      gain.gain.exponentialRampToValueAtTime(level * 0.72, start + 0.1);
      gain.gain.setValueAtTime(level * 0.72, noteEnd);
      gain.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);
      source.connect(gain);
      gain.connect(master);
      source.start(start);
      source.stop(releaseEnd + 0.01);
    });

    const rendered = await offline.startRendering();
    const url = URL.createObjectURL(this.encodeWave(rendered));
    const audio = new Audio(url);
    audio.volume = 1;
    audio.preload = "auto";
    return { audio, url, span: chunkSpan };
  }

  private encodeWave(buffer: AudioBuffer) {
    const samples = buffer.getChannelData(0);
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const write = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    };
    write(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(
        44 + index * 2,
        value < 0 ? value * 32768 : value * 32767,
        true,
      );
    }
    return new Blob([bytes], { type: "audio/wav" });
  }

  private loadSamples() {
    if (!this.context) return Promise.resolve();
    if (!this.loadingSamples) {
      this.loadingSamples = Promise.all(
        PIANO_SAMPLES.map(async ([name, midi]) => {
          try {
            const response = await fetch(`/audio/piano/${name}.mp3`);
            if (!response.ok) return;
            const buffer = await this.context!.decodeAudioData(
              await response.arrayBuffer(),
            );
            this.samples.set(midi, buffer);
          } catch {
            // A single unsupported/corrupt sample must not mute the instrument.
          }
        }),
      ).then(() => {
        if (this.samples.size === 0) {
          throw new Error("Браузер не смог декодировать фортепианные сэмплы.");
        }
      });
    }
    return this.loadingSamples;
  }

  setVolume(value: number) {
    this.volume = value;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(
        value * 0.78,
        this.context.currentTime,
        0.02,
      );
    }
  }

  note(
    midi: number,
    duration: number,
    when = 0,
    transpose = 0,
    polyphony = 1,
  ) {
    if (this.useNativeAudio()) {
      this.nativeNote(midi, duration, when, transpose, polyphony);
      return;
    }
    if (!this.context || !this.master) return;
    const targetMidi = midi + transpose;
    const sampleMidi = PIANO_SAMPLES.reduce((nearest, candidate) =>
      Math.abs(candidate[1] - targetMidi) < Math.abs(nearest[1] - targetMidi)
        ? candidate
        : nearest,
    )[1];
    const buffer = this.samples.get(sampleMidi);
    if (!buffer) return;
    const start = this.context.currentTime + Math.max(0, when);
    const noteEnd = start + Math.max(0.08, duration * 0.98);
    const releaseEnd = noteEnd + Math.min(0.7, Math.max(0.24, duration * 0.45));
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = 2 ** ((targetMidi - sampleMidi) / 12);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.52, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.34, start + 0.09);
    gain.gain.setValueAtTime(0.34, noteEnd);
    gain.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);
    source.connect(gain);
    gain.connect(this.master);
    source.start(start);
    source.stop(releaseEnd + 0.03);
    this.active.add(source);
    source.addEventListener("ended", () => this.active.delete(source));
  }

  private nativeNote(
    midi: number,
    duration: number,
    when: number,
    transpose: number,
    polyphony: number,
  ) {
    const targetMidi = midi + transpose;
    const sampleMidi = PIANO_SAMPLES.reduce((nearest, candidate) =>
      Math.abs(candidate[1] - targetMidi) < Math.abs(nearest[1] - targetMidi)
        ? candidate
        : nearest,
    )[1];
    const template = this.nativeSamples.get(sampleMidi);
    if (!template) return;
    const timer = window.setTimeout(() => {
      this.nativeTimers.delete(timer);
      const audio = template.cloneNode(true) as HTMLAudioElement;
      audio.preservesPitch = false;
      (
        audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }
      ).webkitPreservesPitch = false;
      audio.playbackRate = 2 ** ((targetMidi - sampleMidi) / 12);
      // Native media elements bypass the Web Audio compressor. Normalize each
      // voice by chord size so several notes do not sum into digital clipping.
      audio.volume = Math.min(
        0.5,
        (this.volume * 0.55) / Math.sqrt(Math.max(1, polyphony)),
      );
      this.nativeActive.add(audio);
      const cleanup = () => this.nativeActive.delete(audio);
      audio.addEventListener("ended", cleanup, { once: true });
      void audio.play().catch(cleanup);
      const stopTimer = window.setTimeout(
        () => {
          this.nativeTimers.delete(stopTimer);
          audio.pause();
          cleanup();
        },
        // A piano string continues to resonate after the key is released.
        // Keeping that tail makes phrases and chords blend like a composition.
        Math.max(1400, (duration + 1.05) * 1000),
      );
      this.nativeTimers.add(stopTimer);
    }, Math.max(0, when * 1000));
    this.nativeTimers.add(timer);
  }

  click(accent = false, when = 0, volume = 0.5) {
    if (!this.context || !this.master) return;
    const start = this.context.currentTime + Math.max(0, when);
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1320 : 900;
    gain.gain.setValueAtTime(volume * 0.2, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.04);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(start);
    osc.stop(start + 0.05);
    this.active.add(osc);
    osc.addEventListener("ended", () => this.active.delete(osc));
  }

  stopAll() {
    this.playbackGeneration += 1;
    this.nativeTimers.forEach((timer) => window.clearTimeout(timer));
    this.nativeTimers.clear();
    this.nativeActive.forEach((audio) => {
      audio.pause();
      audio.currentTime = 0;
      const url = this.nativeObjectUrls.get(audio);
      if (url) URL.revokeObjectURL(url);
    });
    this.nativeActive.clear();
    this.nativeObjectUrls.clear();
    if (!this.context) return;
    this.active.forEach((source) => {
      try {
        source.stop(this.context!.currentTime);
      } catch {
        // Source already stopped.
      }
    });
    this.active.clear();
  }
}
