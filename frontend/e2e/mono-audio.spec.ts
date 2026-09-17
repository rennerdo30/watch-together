import { test, expect, type Page } from '@playwright/test';

import { MONO_DOWNMIX_CONFIG } from '../lib/mono-audio';
import { stubAdaptiveStream } from './adaptive-fixture';

/**
 * Mono mode folds every channel into one, so both speakers carry the same mix.
 *
 * Two things can silently break it. The downmix node can be configured so that
 * it does not actually downmix — `channelCountMode: 'max'`, the default, takes
 * the count from the input and passes stereo straight through — which no
 * assertion on React state would notice. And the routing can fail to reach the
 * node at all: the graph is only rebuilt when the option changes, and mono has
 * to build a graph of its own when levelling is switched off.
 */

const USER = 'mono@example.com';
const VIDEO = 'https://youtu.be/mono-fixture';

/** One node of the chain the media element's audio actually flows through. */
interface ChainNode {
  type: string;
  channelCount: number;
  channelCountMode: string;
  /** How many other nodes this one feeds; >1 means the signal is doubled. */
  fanOut: number;
}

/**
 * Record every edge of the page's audio graph.
 *
 * Web Audio exposes no way to read connections back, so `connect`/`disconnect`
 * are wrapped before any page script runs. This is the only way to assert that
 * the element's audio truly passes through the downmix rather than that a flag
 * was flipped.
 */
async function recordAudioGraph(page: Page) {
  await page.addInitScript(() => {
    const edges: { from: AudioNode; to: AudioNode }[] = [];
    (window as unknown as { __audioEdges: typeof edges }).__audioEdges = edges;

    // Both methods are overloaded (node or parameter targets), so they are
    // wrapped through a loose view of the prototype and forwarded untouched.
    const proto = AudioNode.prototype as unknown as
      Record<'connect' | 'disconnect', (...args: unknown[]) => unknown>;
    const connect = proto.connect;
    const disconnect = proto.disconnect;

    proto.connect = function (this: AudioNode, ...args: unknown[]) {
      const [target] = args;
      if (target instanceof AudioNode) edges.push({ from: this, to: target });
      return connect.apply(this, args);
    };

    proto.disconnect = function (this: AudioNode, ...args: unknown[]) {
      const [target] = args;
      for (let i = edges.length - 1; i >= 0; i--) {
        if (edges[i].from !== this) continue;
        if (target instanceof AudioNode && edges[i].to !== target) continue;
        edges.splice(i, 1);
      }
      return disconnect.apply(this, args);
    };
  });
}

/** The chain from the media element's source node to the speakers. */
async function audioChain(page: Page): Promise<ChainNode[]> {
  return page.evaluate(() => {
    const edges = (window as unknown as {
      __audioEdges?: { from: AudioNode; to: AudioNode }[];
    }).__audioEdges ?? [];

    const describe = (node: AudioNode, fanOut: number): ChainNode => ({
      type: node.constructor.name,
      channelCount: node.channelCount,
      channelCountMode: node.channelCountMode,
      fanOut,
    });

    const start = [...edges.map((edge) => edge.from), ...edges.map((edge) => edge.to)]
      .find((node) => node instanceof MediaElementAudioSourceNode);
    if (!start) return [];

    const chain: ChainNode[] = [];
    const seen = new Set<AudioNode>();
    let node: AudioNode = start;
    while (!seen.has(node)) {
      seen.add(node);
      const outgoing = edges.filter((edge) => edge.from === node).map((edge) => edge.to);
      chain.push(describe(node, outgoing.length));
      if (outgoing.length !== 1) break;
      node = outgoing[0];
      if (node instanceof AudioDestinationNode) {
        chain.push(describe(node, 0));
        break;
      }
    }
    return chain;
  });
}

const reachesSpeakers = (chain: ChainNode[]) =>
  chain.length > 0 && chain[chain.length - 1].type === 'AudioDestinationNode';

const downmixes = (chain: ChainNode[]) =>
  chain.some((node) => node.channelCount === 1 && node.channelCountMode === 'explicit');

async function openRoom(page: Page, label: string) {
  await stubAdaptiveStream(page, VIDEO);
  await page.goto(`/room/e2e-${label}-${Date.now().toString(36)}?user=${encodeURIComponent(USER)}`);
  await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
  const input = page.getByPlaceholder('Paste video URL...');
  await input.fill(VIDEO);
  await input.press('Enter');
  const media = page.locator('video[data-stream-type="mse"]');
  await expect(media).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState),
    { timeout: 20_000 }).toBeGreaterThan(0);
  // Paused, so the control bar never fades out from under a click.
  await expect.poll(() => media.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await media.evaluate((v: HTMLVideoElement) => v.pause());
  return media;
}

const settingsButton = (page: Page) =>
  page.getByRole('button', { name: 'Quality and sync settings' });

async function toggleMono(page: Page, expected: 'On' | 'Off') {
  await settingsButton(page).click();
  const toggle = page.getByRole('button', { name: /mono audio/i });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(expected === 'On'));
  await settingsButton(page).click();
}

test('the downmix configuration sums the channels instead of passing them through',
  async ({ page }) => {
    // A real render, because the defect this guards against is a property
    // whose wrong value is still a perfectly valid property.
    const peaks = await page.evaluate(async (config) => {
      const render = async (apply: boolean, channels: [number, number]) => {
        const context = new OfflineAudioContext({
          numberOfChannels: 2, length: 128, sampleRate: 48000,
        });
        const buffer = context.createBuffer(2, 128, 48000);
        buffer.getChannelData(0).fill(channels[0]);
        buffer.getChannelData(1).fill(channels[1]);
        const source = context.createBufferSource();
        source.buffer = buffer;

        const node = context.createGain();
        if (apply) {
          node.channelCount = config.channelCount;
          node.channelCountMode = config.channelCountMode;
          node.channelInterpretation = config.channelInterpretation;
        }
        source.connect(node);
        node.connect(context.destination);
        source.start();

        const rendered = await context.startRendering();
        return [0, 1].map((channel) => Math.max(
          ...Array.from(rendered.getChannelData(channel), Math.abs)));
      };
      return {
        // Content panned hard to one side: the side that was silent has to
        // wake up, which is the whole point of the mode.
        monoOneSided: await render(true, [1, 0]),
        stereoOneSided: await render(false, [1, 0]),
        // Opposites: a real sum cancels them, a pass-through cannot.
        monoOpposed: await render(true, [1, -1]),
        stereoOpposed: await render(false, [1, -1]),
      };
    }, MONO_DOWNMIX_CONFIG);

    expect(peaks.stereoOneSided[0]).toBeCloseTo(1, 5);
    expect(peaks.stereoOneSided[1]).toBeCloseTo(0, 5);
    expect(peaks.monoOneSided[0]).toBeCloseTo(0.5, 5);
    expect(peaks.monoOneSided[1]).toBeCloseTo(0.5, 5);

    expect(peaks.stereoOpposed[0]).toBeCloseTo(1, 5);
    expect(peaks.stereoOpposed[1]).toBeCloseTo(1, 5);
    expect(peaks.monoOpposed[0]).toBeCloseTo(0, 5);
    expect(peaks.monoOpposed[1]).toBeCloseTo(0, 5);
  });

test('mono routes the playing element through the downmix, with levelling off',
  async ({ page }) => {
    await recordAudioGraph(page);
    // Levelling off: mono has to stand up a graph by itself.
    await page.addInitScript(() => {
      localStorage.setItem('w2g-player-normalization', 'false');
    });
    await openRoom(page, 'mono-alone');

    expect(downmixes(await audioChain(page))).toBe(false);

    await toggleMono(page, 'On');
    await expect.poll(async () => {
      const chain = await audioChain(page);
      return reachesSpeakers(chain) && downmixes(chain);
    }).toBe(true);

    // Switching it off restores stereo and leaves the audio audible, rather
    // than stranding the source or feeding the speakers twice.
    await toggleMono(page, 'Off');
    await expect.poll(async () => {
      const chain = await audioChain(page);
      return { speakers: reachesSpeakers(chain), mono: downmixes(chain), fanOut: chain.map((n) => n.fanOut) };
    }).toEqual({ speakers: true, mono: false, fanOut: [1, 0] });
  });

test('mono survives a reload and sits after the normalization stage',
  async ({ page }) => {
    await recordAudioGraph(page);
    await openRoom(page, 'mono-persist');
    await toggleMono(page, 'On');
    expect(await page.evaluate(() => localStorage.getItem('w2g-player-mono'))).toBe('true');

    await page.reload();
    await expect(page.getByLabel('Connected to the room')).toBeVisible({ timeout: 15_000 });
    const media = page.locator('video[data-stream-type="mse"]');
    await expect(media).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => media.evaluate((v: HTMLVideoElement) => v.readyState),
      { timeout: 20_000 }).toBeGreaterThan(0);

    await expect.poll(async () => {
      const chain = await audioChain(page);
      if (!reachesSpeakers(chain) || !downmixes(chain)) return null;
      return chain.map((node) => node.type);
    }, { timeout: 15_000 }).toEqual([
      'MediaElementAudioSourceNode', 'DynamicsCompressorNode', 'GainNode', 'GainNode',
      'AudioDestinationNode',
    ]);

    await settingsButton(page).click();
    await expect(page.getByRole('button', { name: /mono audio/i }))
      .toHaveAttribute('aria-pressed', 'true');
  });
