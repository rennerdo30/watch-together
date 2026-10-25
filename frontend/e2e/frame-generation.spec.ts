import { test, expect, type Page } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';

test.use({ launchOptions: { channel: 'chromium', args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader'] } });
async function openPlayer(page: Page, label: string) {
  const manifests = await stubAdaptiveStream(page, 'https://youtu.be/framegen-fixture');
  await page.goto(`/room/e2e-framegen-${label}-${Date.now().toString(36)}?user=framegen@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  await page.getByPlaceholder('Paste video URL...').fill('https://youtu.be/framegen-fixture');
  await page.getByPlaceholder('Paste video URL...').press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.loop = true; v.muted = true; v.dataset.identity = 'original'; });
  await page.getByRole('button', { name: 'Quality and sync settings', exact: true }).click();
  return { video, manifests, select: page.getByLabel('Motion smoothing (beta)'), status: page.getByRole('status', { name: 'Motion smoothing status' }), layer: page.locator('[data-frame-generation]') };
}

test('off loads no assets and unsupported browsers retain original playback', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  const assets: string[] = []; page.on('request', r => { if (r.url().includes('/framegen/')) assets.push(r.url()); });
  const { video, manifests, select, status, layer } = await openPlayer(page, 'unsupported');
  const baseline = manifests.length;
  expect(assets).toEqual([]);
  await select.selectOption('30');
  await expect(status).toContainText('unavailable');
  expect(assets).toEqual([]);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(await video.getAttribute('data-identity')).toBe('original');
  expect(manifests.length).toBe(baseline);
  await select.selectOption('off'); await expect(layer.locator('canvas')).toHaveCount(0);
});

test('real WebGPU model generates distinct intermediate frames and preserves orientation', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  const capable = await page.evaluate(async () => (await navigator.gpu?.requestAdapter())?.features.has('shader-f16') ?? false);
  test.skip(!capable, 'No float16 WebGPU adapter in this browser');
  const result = await page.evaluate(async () => {
    const worker = new Worker('/framegen/v1/interpolation.worker.js');
    let id = 0;
    const request = (payload: object, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const current = ++id;
      const timeout = setTimeout(() => reject(new Error('GPU test timeout')), 60000);
      worker.onmessage = ({ data }) => {
        if (data.type === 'fatal') { clearTimeout(timeout); reject(new Error(data.error)); return; }
        if (data.id !== current) return;
        clearTimeout(timeout); if (data.error) reject(new Error(data.error)); else resolve(data);
      };
      worker.onerror = e => reject(new Error(e.message));
      worker.postMessage({ ...payload, id: current }, transfer);
    });
    try {
      await request({ type: 'init', width: 64, height: 64 });
      const make = async (x: number) => {
        const c = new OffscreenCanvas(64, 64); const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = '#ff0000'; ctx.fillRect(x, 8, 16, 16);
        return createImageBitmap(c);
      };
      const a = await make(12); await request({ type: 'frame', frame: a, time: 0, fps: 60, reset: true }, [a]);
      const b = await make(20); const reply = await request({ type: 'frame', frame: b, time: 1 / 24, fps: 60 }, [b]);
      const frames = reply.frames as { time: number; frame: ImageBitmap }[];
      const values = frames.map(({ time, frame }) => {
        const c = new OffscreenCanvas(64, 64), ctx = c.getContext('2d')!; ctx.drawImage(frame, 0, 0); frame.close();
        const pixels = ctx.getImageData(0, 0, 64, 64).data;
        let redX = 0, redY = 0, weight = 0;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
          const r = pixels[(y * 64 + x) * 4]; redX += x * r; redY += y * r; weight += r;
        }
        return { time, x: redX / weight, y: redY / weight, blue: pixels[(56 * 64 + 32) * 4 + 2] };
      });
      const cutCanvas = new OffscreenCanvas(64, 64), cutContext = cutCanvas.getContext('2d')!;
      cutContext.fillStyle = '#00ff00'; cutContext.fillRect(0, 0, 64, 64);
      const cut = await createImageBitmap(cutCanvas);
      const cutReply = await request({ type: 'frame', frame: cut, time: 2 / 24, fps: 60 }, [cut]);
      const cutColors = (cutReply.frames as { frame: ImageBitmap }[]).map(({ frame }) => {
        cutContext.drawImage(frame, 0, 0); frame.close();
        return Array.from(cutContext.getImageData(0, 0, 1, 1).data).slice(0, 3);
      });
      return { values, cutColors };
    } finally { worker.terminate(); }
  });
  expect(result.values).toHaveLength(3);
  expect(result.values[0].x).toBeCloseTo(19.5, 0);
  expect(result.values[1].x).toBeGreaterThan(result.values[0].x + 1);
  expect(result.values[2].x).toBeGreaterThan(result.values[1].x + 1);
  for (const sample of result.values) { expect(sample.y).toBeGreaterThan(12); expect(sample.y).toBeLessThan(21); expect(sample.blue).toBeGreaterThan(240); }
  expect(result.cutColors).toEqual([[0, 0, 255], [0, 255, 0]]);
});

test('real player smooths motion, compensates audio, and restores playback after seek/off', async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    const nodes: DelayNode[] = [];
    Object.assign(window, { __framegenDelays: nodes });
    const original = AudioContext.prototype.createDelay;
    AudioContext.prototype.createDelay = function (...args) {
      const node = original.apply(this, args); nodes.push(node); return node;
    };
  });
  const { video, manifests, select, status, layer } = await openPlayer(page, 'real-player');
  const capable = await page.evaluate(async () => (await navigator.gpu?.requestAdapter())?.features.has('shader-f16') ?? false);
  test.skip(!capable, 'No float16 WebGPU adapter in this browser');
  const baseline = manifests.length;
  await select.selectOption('30');
  await expect(status).toContainText('Ready', { timeout: 60000 });
  await video.evaluate((v: HTMLVideoElement) => v.play());
  await expect(layer).toHaveAttribute('data-frame-generation', 'active', { timeout: 20000 });
  const delay = () => page.evaluate(() => (window as unknown as { __framegenDelays: DelayNode[] }).__framegenDelays.at(-1)?.delayTime.value ?? -1);
  await expect.poll(delay).toBeCloseTo(0.12, 4);
  await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 2; });
  await expect(layer.locator('canvas')).toBeHidden();
  await expect.poll(delay).toBe(0);
  await video.evaluate((v: HTMLVideoElement) => v.play());
  await expect(layer).toHaveAttribute('data-frame-generation', 'active');
  await select.selectOption('off');
  await expect(layer.locator('canvas')).toHaveCount(0);
  await expect.poll(delay).toBe(0);
  await select.selectOption('60');
  await expect(select).toHaveValue('60');
  await select.selectOption('off');
  await page.screenshot({ path: '/tmp/w2g-framegen-settings.png' });
  expect(await video.getAttribute('data-identity')).toBe('original');
  expect(await video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1);
  expect(manifests.length).toBe(baseline);
});

test('worker failure returns to original and disabling during startup never resurrects output', async ({ page }) => {
  await page.route('**/framegen/v1/interpolation.worker.js', route => route.fulfill({
    contentType: 'text/javascript', body: `onmessage = ({data}) => setTimeout(() => postMessage({id:data.id,error:'Test GPU unavailable'}), 100);`,
  }));
  const { select, status, layer, video } = await openPlayer(page, 'failed-worker');
  const capable = await page.evaluate(() => !!navigator.gpu);
  test.skip(!capable, 'No WebGPU API');
  await select.selectOption('30');
  await expect(status).toContainText('Test GPU unavailable');
  await expect(layer.locator('canvas')).toBeHidden();
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await select.selectOption('off');
  await select.selectOption('60');
  await select.selectOption('off');
  await expect(layer.locator('canvas')).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(layer.locator('canvas')).toHaveCount(0);
});
