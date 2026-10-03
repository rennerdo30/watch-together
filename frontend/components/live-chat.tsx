'use client';

import { useState } from 'react';
import { ExternalLink, Link2, RotateCw } from 'lucide-react';
import type { ResolveResponse } from '@/lib/api';
import { chatUrl, resolveLiveChat } from '@/lib/live-chat';

const AHEAD_NOTE = 'Chat updates live and may run ahead of the video.';

const toolButton = 'flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--accent-primary)]';

/**
 * Mounted only while its tab is open; changing streams resets the entire panel.
 *
 * The provider's own chat draws its own header, so ours is one compact row
 * of tools above it and the chat gets every other pixel of the panel. The
 * chat-source form only appears when asked for, or when there is no chat to
 * embed at all.
 */
export function LiveChat({ video }: { video: ResolveResponse | null }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const source = origin ? resolveLiveChat(video, origin) : undefined;
  const storageKey = `wt-live-chat:${video?.original_url ?? ''}`;
  const [customUrl, setCustomUrl] = useState(() => {
    try { return chatUrl(sessionStorage.getItem(storageKey) || '', origin) || ''; }
    catch { return ''; }
  });
  const [draft, setDraft] = useState(customUrl);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [choosingSource, setChoosingSource] = useState(false);

  if (!video?.is_live) return <p className="p-4 text-sm text-neutral-400">Start a livestream to open its chat.</p>;
  const embedUrl = customUrl || source?.embedUrl;
  const openUrl = customUrl || source?.openUrl;
  const openLabel = customUrl ? 'Open chat' : source?.openLabel || 'Open chat';
  const title = customUrl ? 'Custom live chat' : `${source?.provider ?? 'Stream'} live chat`;
  const save = (url: string) => {
    setCustomUrl(url);
    setDraft(url);
    setError('');
    setChoosingSource(false);
    try {
      if (url) sessionStorage.setItem(storageKey, url);
      else sessionStorage.removeItem(storageKey);
    } catch { /* Chat still works when browser storage is unavailable. */ }
  };
  const showSourceForm = choosingSource || !embedUrl;

  return <section aria-label="Livestream chat" className="h-full flex flex-col min-h-0 text-xs">
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-neutral-800 pl-3 pr-1.5">
      <span className="min-w-0 flex-1 truncate font-medium text-neutral-200" title={AHEAD_NOTE} aria-description={AHEAD_NOTE}>
        {title}
      </span>
      {embedUrl && (
        <button type="button" onClick={() => setReload(n => n + 1)} aria-label="Reload chat" title="Reload chat" className={toolButton}>
          <RotateCw aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      )}
      {openUrl && (
        <a href={openUrl} target="_blank" rel="noopener noreferrer" aria-label={openLabel} title={`${openLabel} in a new window`} className={toolButton}>
          <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
        </a>
      )}
      <button
        type="button"
        onClick={() => setChoosingSource(open => !open)}
        aria-label="Chat from another service"
        aria-expanded={showSourceForm}
        title="Chat from another service"
        className={`${toolButton} ${choosingSource ? 'bg-white/5 text-white' : ''}`}
      >
        <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>

    {showSourceForm && (
      <form className="shrink-0 space-y-2 border-b border-neutral-800 p-3" onSubmit={event => {
        event.preventDefault();
        const url = chatUrl(draft.trim(), origin);
        if (!url) { setError('Enter an external HTTPS chat URL.'); return; }
        save(url);
      }}>
        {!embedUrl && <p className="text-neutral-400">{source?.note || 'No automatic chat embed is available. Add a chat URL or open the original stream.'}</p>}
        <label htmlFor="custom-chat-url" className="block text-neutral-400">Paste a pop-out or embed URL from any chat service that allows embedding. Saved for this stream in this browser tab.</label>
        <input id="custom-chat-url" type="url" value={draft} onChange={event => setDraft(event.target.value)} placeholder="https://…/chat" className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-2 text-white" />
        {error && <p role="alert" className="text-red-400">{error}</p>}
        <div className="flex gap-3">
          <button type="submit" className="text-[color:var(--accent-secondary)] hover:underline">Use chat URL</button>
          {customUrl && <button type="button" onClick={() => save('')} className="text-neutral-400 hover:underline">Use automatic chat</button>}
        </div>
      </form>
    )}

    {embedUrl && <iframe
      key={`${embedUrl}:${reload}`}
      src={embedUrl}
      title={title}
      className="w-full flex-1 min-h-48 border-0 bg-neutral-950"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="strict-origin-when-cross-origin"
    />}
  </section>;
}
