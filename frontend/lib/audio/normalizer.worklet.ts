import { LoudnessNormalizer } from './loudness';
// AudioWorklet globals are not included in TypeScript's DOM declarations.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
class NormalizerProcessor extends AudioWorkletProcessor {
  private normalizer = new LoudnessNormalizer(sampleRate);
  private samples = 0;
  private alive = true;
  constructor() {
    super(); this.port.onmessage = ({ data }) => {
      if (data.type === 'reset') this.normalizer.reset();
      if (data.type === 'dispose') this.alive = false;
      if (data.type === 'volume') this.normalizer.setInputVolume(data.volume);
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (!this.alive) return false;
    this.normalizer.process(inputs[0] ?? [], outputs[0] ?? []);
    this.samples += outputs[0]?.[0]?.length ?? 0;
    if (this.samples >= sampleRate) {
      this.samples = 0;
      this.port.postMessage({ gainDb: this.normalizer.gainDb, loudness: this.normalizer.measuredLufs });
    }
    return true;
  }
}
registerProcessor('w2g-loudness-normalizer', NormalizerProcessor);
