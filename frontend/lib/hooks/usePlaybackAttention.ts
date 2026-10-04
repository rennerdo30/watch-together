'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { PlaybackStart } from '@/lib/playback';
import {
    NOTIFY_STORAGE_KEY, attentionNotice, attentionTitle, canAutoplayAudibly, hasBeenActivated,
} from '@/lib/playback-attention';
import { parseStoredBoolean, useLocalStorageState } from './useLocalStorageState';

/** What the room knows about the video it is playing, for the viewer's attention. */
export interface AttentionVideo {
    title: string;
    playing: boolean;
}

export type NotifyState = 'unsupported' | 'denied' | 'off' | 'on';

/** Desktop notifications exist here and are not refused. */
function notificationPermission(): NotificationPermission | 'unsupported' {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

// The permission changes only through `requestPermission` here, so whoever
// asked tells the subscribers.
const permissionListeners = new Set<() => void>();
const subscribePermission = (notify: () => void) => {
    permissionListeners.add(notify);
    return () => { permissionListeners.delete(notify); };
};

// Fixed for the life of the page: it describes how the page was loaded.
const subscribeNothing = () => () => { };
const readWasDiscarded = () => (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;

const subscribeVisibility = (notify: () => void) => {
    document.addEventListener('visibilitychange', notify);
    return () => document.removeEventListener('visibilitychange', notify);
};

/**
 * Keeps a viewer who left the room in a background tab aware of what it plays.
 *
 * - `needsGesture`: the browser would not let a video start here with sound;
 *   the page asks for the one click that changes that, once, while nothing
 *   is playing yet. Any click or key press in the page answers it.
 * - The tab title says what is playing, and says it loudest when the start
 *   needs the viewer: muted, or held back entirely.
 * - With the viewer's opt-in, a desktop notification when a video starts in a
 *   hidden tab, replaced by a sharper one if the start went wrong.
 * - `wasDiscarded`: Chrome's Memory Saver unloaded this tab while it sat in
 *   the background and it has just been loaded again. A discarded tab runs
 *   no code, so nothing here could have played or notified meanwhile; the
 *   only cure is the browser setting that exempts the site, so the viewer
 *   is told where it is.
 */
export function usePlaybackAttention(video: AttentionVideo | null, gate: PlaybackStart) {
    const [needsGesture, setNeedsGesture] = useState(false);
    const discarded = useSyncExternalStore(subscribeNothing, readWasDiscarded, () => false);
    const [discardSeen, setDiscardSeen] = useState(false);
    const dismissDiscarded = useCallback(() => setDiscardSeen(true), []);
    const [notifyWanted, setNotifyWanted] = useLocalStorageState(NOTIFY_STORAGE_KEY, false, parseStoredBoolean);
    const permission = useSyncExternalStore(subscribePermission, notificationPermission, () => 'default' as const);
    const hidden = useSyncExternalStore(subscribeVisibility, () => document.hidden, () => false);

    // === THE ONE CLICK ===
    useEffect(() => {
        let disposed = false;
        const armed = () => {
            setNeedsGesture(false);
            window.removeEventListener('click', armed, true);
            window.removeEventListener('keydown', armed, true);
        };
        window.addEventListener('click', armed, true);
        window.addEventListener('keydown', armed, true);
        if (!hasBeenActivated()) {
            void canAutoplayAudibly().then((allowed) => {
                if (!disposed && !allowed && !hasBeenActivated()) setNeedsGesture(true);
            });
        }
        return () => {
            disposed = true;
            window.removeEventListener('click', armed, true);
            window.removeEventListener('keydown', armed, true);
        };
    }, []);

    // === THE TAB TITLE ===
    // The page's own title, as it stood before this hook first changed it.
    const baseTitleRef = useRef<string | null>(null);
    useEffect(() => {
        if (baseTitleRef.current === null) baseTitleRef.current = document.title;
        document.title = attentionTitle(baseTitleRef.current, video && { ...video, gate });
    }, [video, gate]);
    useEffect(() => () => {
        if (baseTitleRef.current !== null) document.title = baseTitleRef.current;
    }, []);

    // === DESKTOP NOTIFICATIONS ===
    const notifyOn = notifyWanted && permission === 'granted';
    const noticeRef = useRef<Notification | null>(null);
    // The start the current notice is about, so the gate's verdict on it can
    // replace the notice, and a verdict about an older video cannot.
    const announcedRef = useRef<{ title: string; gate: PlaybackStart } | null>(null);

    const show = useCallback((title: string, gateNow: PlaybackStart, addedBy?: string) => {
        if (!notifyOn || !document.hidden) return;
        const { title: heading, body } = attentionNotice(title, gateNow, addedBy);
        try {
            noticeRef.current?.close();
            const notice = new Notification(heading, { body, tag: 'w2g-video-start', icon: '/apple-touch-icon.png' });
            notice.onclick = () => {
                window.focus();
                notice.close();
            };
            noticeRef.current = notice;
        } catch {
            // Some browsers only allow notifications from a service worker.
        }
    }, [notifyOn]);

    /** The room just started a new video: tell a viewer who is not looking. */
    const announce = useCallback((title: string, addedBy?: string) => {
        announcedRef.current = { title, gate: 'started' };
        show(title, 'started', addedBy);
    }, [show]);

    useEffect(() => {
        const announced = announcedRef.current;
        if (!announced || !video || video.title !== announced.title) return;
        if (gate === announced.gate || gate === 'started') return;
        announced.gate = gate;
        show(announced.title, gate);
    }, [gate, video, show]);

    // Back in the tab: whatever the notice said is on screen now.
    useEffect(() => {
        if (!hidden) noticeRef.current?.close();
    }, [hidden]);

    const enableNotifications = useCallback(async () => {
        if (typeof Notification === 'undefined') return;
        const answer = Notification.permission === 'default'
            ? await Notification.requestPermission()
            : Notification.permission;
        permissionListeners.forEach((notify) => notify());
        setNotifyWanted(answer === 'granted');
    }, [setNotifyWanted]);

    const disableNotifications = useCallback(() => setNotifyWanted(false), [setNotifyWanted]);

    const notifyState: NotifyState = permission === 'unsupported' ? 'unsupported'
        : permission === 'denied' ? 'denied'
            : notifyOn ? 'on' : 'off';

    return {
        needsGesture, notifyState, enableNotifications, disableNotifications, announce,
        wasDiscarded: discarded && !discardSeen, dismissDiscarded,
    };
}
