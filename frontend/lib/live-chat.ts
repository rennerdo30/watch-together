/** Provider adapters describe chat independently of the video playback engine. */
export interface ChatSource {
  provider: string;
  openUrl: string;
  openLabel?: string;
  embedUrl?: string;
  note?: string;
}

interface LiveVideo {
  original_url?: string;
  webpage_url?: string;
  extractor_key?: string;
  is_live: boolean;
}

type Adapter = (url: URL, video: LiveVideo, parent: string) => ChatSource | undefined;
const hostIs = (url: URL, host: string) => url.hostname === host || url.hostname.endsWith(`.${host}`);

/** Only external HTTPS pages may run in the chat frame. Never embed our own app. */
export function chatUrl(value: string, appOrigin: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.origin === appOrigin) return;
    return url.href;
  } catch { return; }
}

const adapters: Adapter[] = [
  (url, _video, parent) => {
    if (!hostIs(url, 'twitch.tv')) return;
    const channel = url.pathname.match(/^\/([a-zA-Z0-9_]+)\/?$/)?.[1];
    if (!channel || ['directory', 'videos', 'downloads', 'settings'].includes(channel.toLowerCase())) return;
    return {
      provider: 'Twitch',
      openUrl: `https://www.twitch.tv/popout/${channel}/chat?popout=`,
      embedUrl: `https://www.twitch.tv/embed/${channel}/chat?parent=${encodeURIComponent(parent)}&darkpopout`,
    };
  },
  (url, _video, parent) => {
    let id: string | null | undefined;
    if (hostIs(url, 'youtu.be')) id = url.pathname.split('/')[1];
    else if (hostIs(url, 'youtube.com')) {
      id = url.searchParams.get('v') || url.pathname.match(/^\/(?:live|embed|shorts)\/([^/]+)/)?.[1];
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return;
    const openUrl = `https://www.youtube.com/live_chat?v=${id}`;
    return {
      provider: 'YouTube', openUrl,
      embedUrl: `${openUrl}&embed_domain=${encodeURIComponent(parent)}`,
      note: 'YouTube does not support embedded chat on mobile web. Use Open chat there.',
    };
  },
  (url, video) => {
    // Self-hosted instances cannot be recognized by a fixed hostname list.
    if (video.extractor_key?.toLowerCase() !== 'owncast') return;
    const openUrl = `${url.origin}/embed/chat/readwrite`;
    return { provider: 'Owncast', openUrl, embedUrl: openUrl };
  },
  (url) => {
    if (!hostIs(url, 'kick.com')) return;
    const channel = url.pathname.match(/^\/([\w-]+)\/?$/)?.[1];
    if (!channel) return;
    // Official pop-out documented by Kick; served without a frame restriction.
    const openUrl = `https://kick.com/popout/${channel}/chat`;
    return { provider: 'Kick', openUrl, embedUrl: openUrl };
  },
];

export function resolveLiveChat(video: LiveVideo | null, appOrigin: string): ChatSource | undefined {
  if (!video?.is_live) return;
  const source = chatUrl(video.webpage_url || video.original_url || '', appOrigin);
  if (!source) return;
  const url = new URL(source);
  const parent = new URL(appOrigin).hostname;
  for (const adapter of adapters) {
    const match = adapter(url, video, parent);
    if (match) return match;
  }
  // Any provider remains usable even when it offers no embeddable chat.
  return { provider: url.hostname, openUrl: source, openLabel: 'Open original stream', note: 'Open the stream’s original page to use its chat, or add a chat embed URL below.' };
}
