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

export class PianoSynth {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private active = new Set<AudioScheduledSourceNode>();
  private samples = new Map<number, AudioBuffer>();
  private loadingSamples: Promise<void> | null = null;
  private volume = 0.7;

  async resume() {
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
    await this.loadSamples();
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }

  private loadSamples() {
    if (!this.context) return Promise.resolve();
    if (!this.loadingSamples) {
      this.loadingSamples = Promise.all(
        PIANO_SAMPLES.map(async ([name, midi]) => {
          const response = await fetch(`/audio/piano/${name}.mp3`);
          if (!response.ok) throw new Error(`Piano sample ${name} is unavailable`);
          const buffer = await this.context!.decodeAudioData(
            await response.arrayBuffer(),
          );
          this.samples.set(midi, buffer);
        }),
      ).then(() => undefined);
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

  note(midi: number, duration: number, when = 0, transpose = 0) {
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
