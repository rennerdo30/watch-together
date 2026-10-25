/** Streaming K-weighted loudness levelling, not whole-program EBU R128 mastering.
 * Filter design: ITU BS.1770 / De Man bilinear transform, sample-rate adjusted.
 * Reference: https://github.com/csteinmetz1/pyloudnorm (DeMan filter definitions).
 * Gate is deliberately conservative (-60 LUFS and -10 LU relative) for playback.
 */
export const LOUDNESS_CONFIG = {
  targetLufs: -18, gateLufs: -60, maxBoostDb: 12, maxCutDb: -24,
  riseDbPerSecond: 1, fallDbPerSecond: 6, peakDb: -1,
} as const;
type Coefficients = readonly [number, number, number, number, number];
export function kWeighting(rate: number): [Coefficients, Coefficients] {
  const shelfK = Math.tan(Math.PI * 1681.9744509555319 / rate);
  const shelfQ = 0.7071752369554193;
  const high = 10 ** (3.99984385397 / 20), middle = high ** 0.499666774155;
  const den = 1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf: Coefficients = [(high + middle * shelfK / shelfQ + shelfK * shelfK) / den,
    2 * (shelfK * shelfK - high) / den, (high - middle * shelfK / shelfQ + shelfK * shelfK) / den,
    2 * (shelfK * shelfK - 1) / den, (1 - shelfK / shelfQ + shelfK * shelfK) / den];
  const hpK = Math.tan(Math.PI * 38.13547087613982 / rate), hpQ = 0.5003270373253953;
  const hpDen = 1 + hpK / hpQ + hpK * hpK;
  return [shelf, [1, -2, 1, 2 * (hpK * hpK - 1) / hpDen, (1 - hpK / hpQ + hpK * hpK) / hpDen]];
}
class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(private c: Coefficients) {}
  tick(x: number) {
    const [b0, b1, b2, a1, a2] = this.c;
    const y = b0 * x + this.z1;
    this.z1 = b1 * x - a1 * y + this.z2;
    this.z2 = b2 * x - a2 * y;
    return y;
  }
}
export class LoudnessNormalizer {
  private filters: [Biquad, Biquad][] = [];
  private energy: Float64Array;
  private coefficients: [Coefficients, Coefficients];
  private position = 0;
  private filled = 0;
  private sum = 0;
  private hop = 0;
  private history = new Float64Array(30);
  private historyIndex = 0;
  private historyLength = 0;
  private targetDb = 0;
  private limiter = 1;
  private sinceSignal = 0;
  private inputVolume = 1;
  gainDb = 0;
  measuredLufs: number | null = null;
  readonly peak = 10 ** (LOUDNESS_CONFIG.peakDb / 20);
  constructor(private rate: number) {
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new Error('Unsupported audio sample rate');
    this.coefficients = kWeighting(rate);
    this.energy = new Float64Array(Math.round(rate * 0.4));
  }
  setInputVolume(volume: number) {
    this.inputVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  }
  reset() {
    this.filters = []; this.energy.fill(0); this.history.fill(0);
    this.position = this.filled = this.sum = this.hop = this.historyIndex = this.historyLength = 0;
    this.targetDb = this.gainDb = this.sinceSignal = 0; this.limiter = 1; this.measuredLufs = null;
  }
  private measure() {
    const power = Math.max(0, this.sum / this.energy.length);
    const momentary = -0.691 + 10 * Math.log10(Math.max(1e-20, power));
    if (momentary < LOUDNESS_CONFIG.gateLufs) {
      this.sinceSignal += 0.1;
      // Never climb through silence/noise. After a pause return gently to unity.
      this.targetDb = Math.min(0, this.gainDb);
      if (this.sinceSignal >= 1) { this.historyLength = 0; this.historyIndex = 0; }
      this.measuredLufs = null; return;
    }
    this.sinceSignal = 0;
    this.history[this.historyIndex] = power;
    this.historyIndex = (this.historyIndex + 1) % this.history.length;
    this.historyLength = Math.min(this.history.length, this.historyLength + 1);
    let total = 0;
    for (let i = 0; i < this.historyLength; i++) total += this.history[i];
    const relativeGate = total / this.historyLength / 10;
    let kept = 0, count = 0;
    for (let i = 0; i < this.historyLength; i++) if (this.history[i] >= relativeGate) { kept += this.history[i]; count++; }
    const loudness = -0.691 + 10 * Math.log10(Math.max(1e-20, kept / Math.max(1, count)));
    this.measuredLufs = loudness;
    this.targetDb = power < relativeGate ? Math.min(0, this.gainDb)
      : Math.max(LOUDNESS_CONFIG.maxCutDb, Math.min(LOUDNESS_CONFIG.maxBoostDb, LOUDNESS_CONFIG.targetLufs - loudness));
  }
  /** Same gain/limiter on every channel preserves stereo balance. No extra latency. */
  process(input: Float32Array[], output: Float32Array[]) {
    const channels = Math.min(2, input.length, output.length);
    const size = output[0]?.length ?? 0;
    if (!channels || this.inputVolume < 1e-5) { output.forEach(channel => channel.fill(0)); return; }
    while (this.filters.length < channels) this.filters.push([new Biquad(this.coefficients[0]), new Biquad(this.coefficients[1])]);
    const release = Math.exp(-1 / (this.rate * 0.1));
    for (let i = 0; i < size; i++) {
      let energy = 0, peak = 0;
      for (let ch = 0; ch < channels; ch++) {
        const x = Number.isFinite(input[ch][i]) ? input[ch][i] : 0;
        const y = this.filters[ch][1].tick(this.filters[ch][0].tick(x / this.inputVolume));
        energy += y * y; peak = Math.max(peak, Math.abs(x));
      }
      this.sum += energy - this.energy[this.position]; this.energy[this.position] = energy;
      this.position = (this.position + 1) % this.energy.length;
      this.filled = Math.min(this.energy.length, this.filled + 1);
      if (++this.hop >= Math.round(this.rate * 0.1)) { this.hop = 0; if (this.filled === this.energy.length) this.measure(); }
      const step = (this.targetDb < this.gainDb ? LOUDNESS_CONFIG.fallDbPerSecond : LOUDNESS_CONFIG.riseDbPerSecond) / this.rate;
      this.gainDb += Math.max(-step, Math.min(step, this.targetDb - this.gainDb));
      const gain = 10 ** (this.gainDb / 20);
      const userCeiling = this.peak * this.inputVolume;
      const ceiling = peak * gain > userCeiling ? userCeiling / (peak * gain) : 1;
      this.limiter = ceiling < this.limiter ? ceiling : release * this.limiter + (1 - release) * ceiling;
      for (let ch = 0; ch < output.length; ch++) {
        const x = input[ch]?.[i] ?? 0;
        output[ch][i] = Number.isFinite(x) ? x * gain * this.limiter : 0;
      }
    }
  }
}
