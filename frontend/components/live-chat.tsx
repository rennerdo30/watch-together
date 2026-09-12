'use client';

import { useState } from 'react';
import type { ResolveResponse } from '@/lib/api';
import { chatUrl, resolveLiveChat } from '@/lib/live-chat';

/** Mounted only while its tab is open; changing streams resets the entire panel. */
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

  if (!video?.is_live) return <p className="p-4 text-sm text-neutral-400">Start a livestream to open its chat.</p>;
  const embedUrl = customUrl || source?.embedUrl;
  const openUrl = customUrl || source?.openUrl;
  const title = customUrl ? 'Custom live chat' : `${source?.provider ?? 'Stream'} live chat`;
  const save = (url: string) => {
    setCustomUrl(url);
    setDraft(url);
    setError('');
    try {
      if (url) sessionStorage.setItem(storageKey, url);
      else sessionStorage.removeItem(storageKey);
    } catch { /* Chat still works when browser storage is unavailable. */ }
  };

  return <section aria-label="Livestream chat" className="h-full flex flex-col min-h-0 text-xs">
    <div className="p-3 border-b border-neutral-800 shrink-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium truncate">{title}</span>
        {openUrl && <a className="text-blue-400 hover:underline shrink-0" href={openUrl} target="_blank" rel="noopener noreferrer">{customUrl ? 'Open chat' : source?.openLabel || 'Open chat'} ↗</a>}
      </div>
      <p className="text-neutral-400">Chat updates live and may run ahead of the video.</p>
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
      {embedUrl ? <iframe
        key={`${embedUrl}:${reload}`}
        src={embedUrl}
        title={title}
        className="w-full flex-1 min-h-48 border-0 bg-neutral-950"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="strict-origin-when-cross-origin"
      /> : <p className="p-4 text-neutral-400">{source?.note || 'No automatic chat embed is available. Add a chat URL or open the original stream.'}</p>}
    </div>
    <div className="p-3 border-t border-neutral-800 shrink-0 max-h-[50%] overflow-y-auto space-y-2">
      {embedUrl && <p className="text-neutral-400">{!customUrl && source?.note} If chat is blank or sign-in fails, use Open chat. <button type="button" onClick={() => setReload(n => n + 1)} className="text-blue-400 hover:underline">Reload chat</button></p>}
      <details>
        <summary className="cursor-pointer text-neutral-300">Chat from another service</summary>
        <form className="mt-2 space-y-2" onSubmit={event => {
          event.preventDefault();
          const url = chatUrl(draft.trim(), origin);
          if (!url) { setError('Enter an external HTTPS chat URL.'); return; }
          save(url);
          event.currentTarget.closest('details')?.removeAttribute('open');
        }}>
          <label htmlFor="custom-chat-url" className="block text-neutral-400">Paste a pop-out or embed URL from any chat service that allows embedding. Saved for this stream in this browser tab.</label>
          <input id="custom-chat-url" type="url" value={draft} onChange={event => setDraft(event.target.value)} placeholder="https://…/chat" className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-2 text-white" />
          {error && <p role="alert" className="text-red-400">{error}</p>}
          <div className="flex gap-3">
            <button type="submit" className="text-blue-400 hover:underline">Use chat URL</button>
            {customUrl && <button type="button" onClick={() => save('')} className="text-neutral-400 hover:underline">Use automatic chat</button>}
          </div>
        </form>
      </details>
    </div>
  </section>;
}
