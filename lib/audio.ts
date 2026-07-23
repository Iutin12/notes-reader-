export class PianoSynth {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private active = new Set<OscillatorNode>();
  private volume = 0.7;

  async resume() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume * 0.28;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === "suspended") await this.context.resume();
    return this.context;
  }

  setVolume(value: number) {
    this.volume = value;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(
        value * 0.28,
        this.context.currentTime,
        0.02,
      );
    }
  }

  note(midi: number, duration: number, when = 0, transpose = 0) {
    if (!this.context || !this.master) return;
    const start = this.context.currentTime + Math.max(0, when);
    const stop = start + Math.max(0.06, duration);
    const osc = this.context.createOscillator();
    const overtone = this.context.createOscillator();
    const gain = this.context.createGain();
    const overtoneGain = this.context.createGain();
    const frequency = 440 * 2 ** ((midi + transpose - 69) / 12);

    osc.type = "triangle";
    osc.frequency.value = frequency;
    overtone.type = "sine";
    overtone.frequency.value = frequency * 2;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.7, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, stop);
    overtoneGain.gain.value = 0.12;

    osc.connect(gain);
    overtone.connect(overtoneGain);
    overtoneGain.connect(gain);
    gain.connect(this.master);
    osc.start(start);
    overtone.start(start);
    osc.stop(stop + 0.03);
    overtone.stop(stop + 0.03);
    this.active.add(osc);
    this.active.add(overtone);
    osc.addEventListener("ended", () => this.active.delete(osc));
    overtone.addEventListener("ended", () => this.active.delete(overtone));
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
    this.active.forEach((osc) => {
      try {
        osc.stop(this.context!.currentTime);
      } catch {
        // Oscillator already stopped.
      }
    });
    this.active.clear();
  }
}
