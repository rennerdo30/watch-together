import { test, expect, type Page } from '@playwright/test';
import { stubAdaptiveStream } from './adaptive-fixture';
import { PNG } from 'pngjs';

// Full Chromium's new headless mode includes the normal GPU process. The
// headless-shell executable can advertise an adapter then lose it immediately.
test.use({ launchOptions: { channel: 'chromium', args: [
  '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu',
  // Linux CI has no physical GPU. Use Chromium's software Vulkan adapter
  // explicitly instead of an advertised hardware adapter that loses its device.
  ...(process.platform === 'linux' ? ['--enable-features=Vulkan', '--use-angle=vulkan',
    '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'] : []),
] } });

async function openVideo(page: Page, label: string, disableWebGPU = false) {
  if (disableWebGPU) await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  const requests = await stubAdaptiveStream(page, 'https://youtu.be/enhancement-fixture');
  await page.goto(`/room/e2e-enhance-${label}-${Date.now().toString(36)}?user=enhancement@example.com`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible();
  const url = page.getByPlaceholder('Paste video URL...');
  await url.fill('https://youtu.be/enhancement-fixture'); await url.press('Enter');
  const video = page.locator('video[data-stream-type="mse"]');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.loop = true; v.dataset.identity = 'original'; });
  await page.getByRole('button', { name: 'Quality and sync settings', exact: true }).click();
  return { video, requests, select: page.getByLabel('Video enhancement (beta)'),
    status: page.getByRole('status', { name: 'Video enhancement status' }),
    layer: page.locator('[data-video-enhancement]') };
}

test('off loads no models; spatial enhancement toggles and seeks without rebuilding media', async ({ page }) => {
  const assetRequests: string[] = [];
  page.on('request', req => { if (req.url().includes('/upscaling/')) assetRequests.push(req.url()); });
  const { video, requests, select, status, layer } = await openVideo(page, 'spatial', true);
  expect(assetRequests).toEqual([]);
  const baseline = requests.length;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const mode of ['general', 'animation', 'off', 'general']) {
    await select.selectOption(mode);
    if (mode === 'off') await expect(layer.locator('canvas')).toHaveCount(0);
    else {
      await expect(status).toContainText('lightweight');
      await expect(layer.locator('canvas')).toBeVisible();
    }
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  }
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 3; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await expect(layer.locator('canvas')).toBeVisible();
  expect(await video.getAttribute('data-identity')).toBe('original');
  expect(requests.length).toBe(baseline);
  expect(await page.evaluate(() => localStorage.getItem('w2g-player-upscaling-beta'))).toBe('general');
  expect(assetRequests).toEqual([]); // spatial/manual modes need no model downloads
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/video-enhancement-settings.png' });
});

test('without a usable GPU, beta fails open and playback continues', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === 'webgl2') return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  const { video, requests, select, status, layer } = await openVideo(page, 'no-gpu', true);
  const baseline = requests.length;
  await select.selectOption('auto');
  await expect(status).toContainText('original playback continues');
  await expect(layer.locator('canvas')).toHaveCount(0);
  await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.2);
  expect(requests.length).toBe(baseline);
});

test('model download failure falls back to spatial rendering without a stream reload', async ({ page }) => {
  // Deterministically emulate a worker failure even on machines without WebGPU.
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: {} }));
  await page.route('**/upscaling/v1/neural.worker.js', route => route.fulfill({
    contentType: 'text/javascript', body: `self.onmessage = ({data}) => self.postMessage({id:data.id,error:'Model unavailable'});`,
  }));
  const { video, requests, select, status } = await openVideo(page, 'model-error');
  const baseline = requests.length;
  await select.selectOption('animation');
  await expect(status).toContainText('lightweight');
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(requests.length).toBe(baseline);
});

test('the player integrates the real neural renderer without changing its media clock', async ({ page }) => {
  test.setTimeout(60_000);
  const { select, video, layer, requests, status } = await openVideo(page, 'neural-player');
  const capable = await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter());
  test.skip(!capable, 'No WebGPU adapter in this browser environment');
  const baseline = requests.length;
  await select.selectOption('animation');
  await expect(status).toContainText('AI 2×');
  await expect(layer).toHaveAttribute('data-enhancement-backend', 'neural');
  await expect(layer.locator('canvas')).toBeVisible();
  await select.selectOption('general');
  await expect(status).toContainText('General · AI 2×');
  // Software GPU throughput is not representative of a viewer's hardware.
  // Keep actual rendering and playback, but feed fewer frames in this test.
  await video.evaluate((v: HTMLVideoElement) => { v.playbackRate = 0.1; v.muted = true; return v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.2);
  await expect(layer).toHaveAttribute('data-video-enhancement', 'active');
  expect(requests.length).toBe(baseline);
  expect(await video.getAttribute('data-identity')).toBe('original');
});

test('native captions suspend the overlay and removing them restores enhancement', async ({ page }) => {
  const { video, select, status, layer } = await openVideo(page, 'captions', true);
  await select.selectOption('general');
  await expect(status).toContainText('lightweight');
  await video.evaluate((v: HTMLVideoElement) => { const track = v.addTextTrack('captions'); track.mode = 'showing'; });
  await expect(status).toContainText('native captions');
  await expect(layer.locator('canvas')).toBeHidden();
  await video.evaluate((v: HTMLVideoElement) => { v.textTracks[0].mode = 'disabled'; });
  await expect(status).toContainText('lightweight');
  await expect(layer.locator('canvas')).toBeVisible();
});

test('hidden tabs and native picture-in-picture suspend enhancement without changing playback', async ({ page }) => {
  const { video, select, status, layer } = await openVideo(page, 'presentation', true);
  await select.selectOption('general'); await expect(status).toContainText('lightweight');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(layer.locator('canvas')).toHaveCount(0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(status).toContainText('lightweight');
  await video.evaluate((v: HTMLVideoElement) => {
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: v });
    v.dispatchEvent(new Event('enterpictureinpicture'));
  });
  await expect(status).toContainText('picture-in-picture');
  await expect(layer.locator('canvas')).toBeHidden();
  await video.evaluate((v: HTMLVideoElement) => {
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: null });
    v.dispatchEvent(new Event('leavepictureinpicture'));
  });
  await expect(status).toContainText('lightweight');
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test('disabling enhancement during a delayed worker response does not resurrect its canvas', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: {} }));
  await page.route('**/upscaling/v1/neural.worker.js', route => route.fulfill({ contentType: 'text/javascript',
    body: `self.onmessage=({data})=>{ if(data.type==='dispose') return; setTimeout(()=>self.postMessage({id:data.id}),1000); };` }));
  const { select, layer, video } = await openVideo(page, 'late-worker');
  await select.selectOption('animation');
  await expect(layer.locator('canvas')).toHaveCount(1);
  await select.selectOption('off');
  await page.waitForTimeout(1200);
  await expect(layer.locator('canvas')).toHaveCount(0);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test('automatic mode uses confident local classifications and manual selection overrides it', async ({ page }) => {
  test.setTimeout(45_000);
  await page.route('**/upscaling/v1/classifier.worker.js', route => route.fulfill({ contentType: 'text/javascript',
    body: `self.onmessage=({data})=>{if(data.type!=='dispose') self.postMessage({id:data.id,probability:0.99});};` }));
  const { select, status, video, requests } = await openVideo(page, 'automatic', true);
  const baseline = requests.length;
  await select.selectOption('auto');
  // Test classification hysteresis without benchmarking the CI software GPU.
  await video.evaluate((v: HTMLVideoElement) => { v.playbackRate = 0.1; v.muted = true; return v.play(); });
  await expect(status).toContainText('Animation', { timeout: 25_000 });
  await select.selectOption('general');
  await expect(status).toContainText('General');
  expect(requests.length).toBe(baseline);
});

test('beta settings stay within a phone-sized player and remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { select, layer } = await openVideo(page, 'phone', true);
  await select.selectOption('general');
  const panel = page.locator('div[aria-label="Quality and sync settings"]');
  const bounds = await panel.boundingBox();
  const stage = await layer.boundingBox();
  expect(bounds).not.toBeNull(); expect(stage).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(stage!.y);
  expect(bounds!.x).toBeGreaterThanOrEqual(stage!.x);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(stage!.y + stage!.height);
  await expect(select).toBeVisible();
  await page.screenshot({ path: 'test-results/video-enhancement-phone.png' });
});

test('actual local classifier executes with finite binary probabilities and no external requests', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const fetched: string[] = [];
  page.on('request', request => fetched.push(request.url()));
  const result = await page.evaluate(async () => {
    const worker = new Worker('/upscaling/v1/classifier.worker.js');
    const pixels = new Uint8ClampedArray(224 * 224 * 4).fill(128);
    try {
      return await new Promise<{ probability?: number; error?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Classifier timed out')), 45000);
        worker.onmessage = event => { clearTimeout(timeout); resolve(event.data); };
        worker.onerror = error => { clearTimeout(timeout); reject(new Error(error.message)); };
        worker.postMessage({ id: 1, pixels }, [pixels.buffer]);
      });
    } finally { worker.terminate(); }
  });
  expect(result.error).toBeUndefined();
  expect(result.probability).toBeGreaterThanOrEqual(0);
  expect(result.probability).toBeLessThanOrEqual(1);
  expect(fetched.filter(url => new URL(url).hostname !== 'localhost')).toEqual([]);
});

test('actual neural worker renders, changes models, and rebuilds safely for new dimensions', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const capable = await page.evaluate(async () => !!navigator.gpu && !!await navigator.gpu.requestAdapter());
  test.skip(!capable, 'No WebGPU adapter in this browser environment');
  const result = await page.evaluate(async () => {
    const worker = new Worker('/upscaling/v1/neural.worker.js');
    let id = 0;
    const request = (message: object, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const current = ++id;
      const timeout = setTimeout(() => reject(new Error('Neural renderer timed out')), 20000);
      worker.onmessage = ({ data }) => {
        if (data.type === 'fatal') { clearTimeout(timeout); reject(new Error(data.error)); }
        if (data.id === current) { clearTimeout(timeout); if (data.error) reject(new Error(data.error)); else resolve(data); }
      };
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
      worker.postMessage({ ...message, id: current }, transfer);
    });
    const canvas = document.createElement('canvas');
    canvas.id = 'neural-output-test';
    canvas.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;';
    document.body.append(canvas);
    const offscreen = canvas.transferControlToOffscreen();
    try {
      await request({ type: 'init', canvas: offscreen }, [offscreen]);
      const results = [];
      for (const [width, height, mode] of [[64, 48, 'animation'], [64, 48, 'animation'], [64, 48, 'general'], [83, 65, 'general']] as const) {
        const source = new OffscreenCanvas(width, height);
        const ctx = source.getContext('2d')!;
        ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, width, height / 2);
        ctx.fillStyle = '#0000ff'; ctx.fillRect(0, height / 2, width, height / 2);
        const frame = source.transferToImageBitmap();
        const result = await request({ type: 'render', frame, mode }, [frame]);
        results.push(result.changed);
      }
      // Leave the worker/canvas alive until the test page is closed, allowing
      // the browser compositor to present its output before screenshotting.
      return { results };
    } catch (error) { worker.terminate(); canvas.remove(); throw error; }
  });
  expect(result.results).toEqual([true, false, true, true]);
  const output = page.locator('#neural-output-test');
  // OffscreenCanvas placeholder dimensions update asynchronously with the
  // compositor, after the worker has completed its GPU submission.
  await expect.poll(() => output.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])).toEqual([166, 130]);
  const screenshot = PNG.sync.read(await output.screenshot());
  const top = (20 * screenshot.width + 20) * 4;
  const bottom = ((screenshot.height - 20) * screenshot.width + 20) * 4;
  expect(screenshot.data[top]).toBeGreaterThan(150); expect(screenshot.data[top + 2]).toBeLessThan(50);
  expect(screenshot.data[bottom + 2]).toBeGreaterThan(150); expect(screenshot.data[bottom]).toBeLessThan(50);
});
