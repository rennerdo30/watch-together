import { test, expect } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';

test('the shipped worklet levels quiet/loud stereo audio with bounded peaks', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const rate = 48000, seconds = 32;
    const context = new OfflineAudioContext(2, rate * seconds, rate);
    await context.audioWorklet.addModule('/audio/v1/normalizer.worklet.js');
    const buffer = context.createBuffer(2, rate * seconds, rate);
    for (let ch = 0; ch < 2; ch++) {
      const samples = buffer.getChannelData(ch);
      for (let i = 0; i < samples.length; i++) samples[i] = (i < rate * 18 ? 0.03 : 0.3) * Math.sin(2 * Math.PI * 1000 * i / rate);
    }
    const source = context.createBufferSource(); source.buffer = buffer;
    const normalizer = new AudioWorkletNode(context, 'w2g-loudness-normalizer', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    source.connect(normalizer); normalizer.connect(context.destination); source.start();
    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0), right = rendered.getChannelData(1);
    const rms = (start: number, end: number) => {
      let sum = 0; for (let i = start * rate; i < end * rate; i++) sum += left[i] ** 2;
      return Math.sqrt(sum / ((end - start) * rate));
    };
    let peak = 0, difference = 0;
    for (let i = 0; i < left.length; i++) { peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i])); difference = Math.max(difference, Math.abs(left[i] - right[i])); }
    return { quiet: rms(17, 18), loud: rms(31, 32), peak, difference };
  });
  expect(Math.abs(20 * Math.log10(result.quiet / result.loud))).toBeLessThan(1);
  expect(result.peak).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
  expect(result.difference).toBe(0);
});

test('normalization and Night mode are independent, local, and preserve the media source', async ({ page }) => {
  const requests: string[] = []; page.on('request', r => { if (r.url().includes('/audio/')) requests.push(r.url()); });
  const manifests = await stubAdaptiveStream(page, 'https://youtu.be/volume-fixture');
  await page.goto(`/room/e2e-volume-${Date.now().toString(36)}?user=volume@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill('https://youtu.be/volume-fixture');
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.dataset.identity = 'original'; });
  const baseline = manifests.length;
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'Quality and sync settings', exact: true }).click();
  const normalize = page.getByRole('button', { name: 'Normalize volume', exact: true });
  const night = page.getByRole('button', { name: 'Night mode', exact: true });
  await expect(normalize).toHaveAttribute('aria-pressed', 'false');
  await expect(night).toHaveAttribute('aria-pressed', 'true');
  await normalize.click();
  await expect(page.getByRole('status', { name: 'Volume normalization status' })).toContainText('Active');
  await night.click();
  await expect(night).toHaveAttribute('aria-pressed', 'false');
  await expect(normalize).toHaveAttribute('aria-pressed', 'true');
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(await video.getAttribute('data-identity')).toBe('original');
  expect(manifests.length).toBe(baseline);
  await page.screenshot({ path: '/tmp/w2g-volume-normalization.png' });
  await page.reload(); await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByRole('button', { name: 'Quality and sync settings', exact: true }).click();
  await expect(normalize).toHaveAttribute('aria-pressed', 'true'); await expect(night).toHaveAttribute('aria-pressed', 'false');
  await normalize.click(); await expect(normalize).toHaveAttribute('aria-pressed', 'false');
});

test('a worklet loading failure keeps original audio routing available', async ({ page }) => {
  await page.addInitScript(() => {
    const context = new AudioContext();
    Object.getPrototypeOf(context.audioWorklet).addModule = () => Promise.reject(new Error('Test worklet load failure'));
    void context.close();
  });
  await stubAdaptiveStream(page, 'https://youtu.be/volume-failure');
  await page.goto(`/room/e2e-volume-fail-${Date.now().toString(36)}?user=volume@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill('https://youtu.be/volume-failure');
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  await expect(page.locator('video[data-stream-type="mse"]')).toHaveCount(1);
  await page.locator('video[data-stream-type="mse"]').evaluate((v: HTMLVideoElement) => v.pause());
  await page.getByRole('button', { name: 'Quality and sync settings', exact: true }).click();
  await page.getByRole('button', { name: 'Normalize volume', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Volume normalization status' })).toContainText('Unavailable');
  await expect(page.getByRole('button', { name: 'Night mode', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('processor failure bypasses the dead node and Off/on creates one fresh audible path', async ({ page }) => {
  await page.addInitScript(() => {
    const nodes: AudioWorkletNode[] = [];
    const edges: { from: AudioNode; to: AudioNode }[] = [];
    Object.assign(window, { __volumeNodes: nodes, __volumeEdges: edges });
    const Original = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Original {
      constructor(...args: ConstructorParameters<typeof Original>) { super(...args); nodes.push(this); }
    };
    const proto = AudioNode.prototype as unknown as Record<'connect' | 'disconnect', (...args: unknown[]) => unknown>;
    const connect = proto.connect, disconnect = proto.disconnect;
    proto.connect = function (this: AudioNode, ...args: unknown[]) {
      if (args[0] instanceof AudioNode) edges.push({ from: this, to: args[0] });
      return connect.apply(this, args);
    };
    proto.disconnect = function (this: AudioNode, ...args: unknown[]) {
      for (let i = edges.length - 1; i >= 0; i--) if (edges[i].from === this && (!args.length || edges[i].to === args[0])) edges.splice(i, 1);
      return disconnect.apply(this, args);
    };
  });
  await stubAdaptiveStream(page, 'https://youtu.be/volume-processor');
  await page.goto(`/room/e2e-volume-processor-${Date.now().toString(36)}?user=volume@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill('https://youtu.be/volume-processor');
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await page.getByRole('button', { name: 'Quality and sync settings', exact: true }).click();
  const toggle = page.getByRole('button', { name: 'Normalize volume', exact: true });
  const status = page.getByRole('status', { name: 'Volume normalization status' });
  const chain = () => page.evaluate(() => {
    const { __volumeEdges: edges } = window as unknown as { __volumeEdges: { from: AudioNode; to: AudioNode }[] };
    let node = edges.find(e => e.from instanceof MediaElementAudioSourceNode)?.from;
    const seen = new Set<AudioNode>(); let worklets = 0, doubled = false;
    while (node && !seen.has(node)) {
      seen.add(node); if (node instanceof AudioWorkletNode) worklets++;
      if (node instanceof AudioDestinationNode) return { speakers: true, worklets, doubled };
      const outgoing = edges.filter(e => e.from === node); if (outgoing.length > 1) doubled = true;
      node = outgoing[0]?.to;
    }
    return { speakers: false, worklets, doubled };
  });
  await toggle.click(); await expect(status).toContainText('Active');
  await expect.poll(chain).toEqual({ speakers: true, worklets: 1, doubled: false });
  await page.evaluate(() => (window as unknown as { __volumeNodes: AudioWorkletNode[] }).__volumeNodes.at(-1)!.dispatchEvent(new Event('processorerror')));
  await expect(status).toContainText('Unavailable');
  await expect.poll(chain).toEqual({ speakers: true, worklets: 0, doubled: false });
  await toggle.click(); await toggle.click(); await expect(status).toContainText('Active');
  await expect.poll(chain).toEqual({ speakers: true, worklets: 1, doubled: false });
  expect(await page.evaluate(() => (window as unknown as { __volumeNodes: AudioWorkletNode[] }).__volumeNodes.length)).toBe(2);
});

test('real media-element volume remains effective through the normalization worklet', async ({ page }) => {
  await page.goto('/'); await page.locator('body').click({ position: { x: 2, y: 2 } });
  const result = await page.evaluate(async () => {
    const rate = 48000, count = rate * 2, wav = new ArrayBuffer(44 + count * 2), view = new DataView(wav);
    const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, Math.round(0.3 * 32767 * Math.sin(2 * Math.PI * 1000 * i / rate)), true);
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const audio = new Audio(url); audio.loop = true;
    const context = new AudioContext();
    try {
      await context.audioWorklet.addModule('/audio/v1/normalizer.worklet.js');
      const node = new AudioWorkletNode(context, 'w2g-loudness-normalizer', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      const silence = context.createGain(); silence.gain.value = 0;
      context.createMediaElementSource(audio).connect(node); node.connect(analyser); analyser.connect(silence); silence.connect(context.destination);
      await context.resume(); await audio.play();
      await new Promise(resolve => setTimeout(resolve, 2500));
      const measure = () => { const samples = new Float32Array(2048); analyser.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length); };
      const full = measure(); audio.volume = 0.25; node.port.postMessage({ type: 'volume', volume: audio.volume });
      await new Promise(resolve => setTimeout(resolve, 300));
      const reduced = measure(); audio.muted = true; node.port.postMessage({ type: 'volume', volume: 0 });
      await new Promise(resolve => setTimeout(resolve, 100));
      return { ratio: reduced / full, muted: measure(), full };
    } finally { audio.pause(); await context.close(); URL.revokeObjectURL(url); }
  });
  expect(result.full).toBeGreaterThan(0.01);
  expect(result.ratio).toBeGreaterThan(0.22); expect(result.ratio).toBeLessThan(0.28);
  expect(result.muted).toBeLessThan(0.00001);
});
