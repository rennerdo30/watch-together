"use client";

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Play, RefreshCw, Users } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Mascot } from '@/components/mascot';
import { fetchRooms, type RoomSummary } from '@/lib/api';
import { ColorModeToggle } from '@/components/color-mode-toggle';
import {
  APP_NAME,
  GENERATED_ROOM_ID_LENGTH,
  REPOSITORY_URL,
  ROOM_ID_ALLOWED_PATTERN,
  ROOM_LIST_POLL_INTERVAL_MS,
} from '@/lib/constants';

const SKELETON_ROW_COUNT = 4;
const RANDOM_ID_RADIX = 36;

const numberFormatter = new Intl.NumberFormat();

function generateRoomId(): string {
  return Math.random()
    .toString(RANDOM_ID_RADIX)
    .substring(2, 2 + GENERATED_ROOM_ID_LENGTH);
}

export default function Home() {
  const router = useRouter();
  const [roomName, setRoomName] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The mascot cheers while the pointer or focus is on "Create room".
  const [excited, setExcited] = useState(false);

  const loadRooms = useCallback(async () => {
    try {
      const data = await fetchRooms();
      setRooms(data);
      setLoadError(null);
    } catch (error) {
      console.error('[home] Could not load the room list:', error);
      setLoadError(
        error instanceof Error ? error.message : 'The room list could not be loaded.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The loader updates state only after awaiting the network response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRooms();
    const interval = setInterval(loadRooms, ROOM_LIST_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadRooms]);

  const createRoom = (event?: React.FormEvent) => {
    event?.preventDefault();
    const sanitized = roomName.trim().replace(ROOM_ID_ALLOWED_PATTERN, '');
    router.push(`/room/${sanitized || generateRoomId()}`);
  };

  const retry = () => {
    setLoading(true);
    loadRooms();
  };

  const totalUsers = rooms.reduce((sum, room) => sum + room.active_users, 0);

  return (
    <div className="app-shell flex min-h-dvh flex-col bg-neutral-950 text-white">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <BrandMark className="h-8 w-8 shrink-0" />
          <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
        </div>
        <div className="flex items-center gap-3">
          {!loading && !loadError && (
            <p className="flex items-center gap-2 text-sm text-neutral-400">
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${totalUsers > 0 ? 'bg-emerald-500' : 'bg-neutral-600'}`}
              />
              {totalUsers === 1
                ? '1 viewer online'
                : `${numberFormatter.format(totalUsers)} viewers online`}
            </p>
          )}
          <ColorModeToggle />
        </div>
      </header>

      {/* Two columns on a wide screen, stacked on a narrow one. The room list
          scrolls inside its own panel: it used to stretch the page to the
          height of every room, which with a few hundred rooms pushed the
          create form out of sight. */}
      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-16 lg:py-16">
        <section aria-labelledby="hero-heading" className="relative">
          <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[color:var(--accent-glow)] blur-3xl" />
          <Mascot
            followPointer
            mood={excited ? 'happy' : 'idle'}
            className="relative mb-6 h-24 w-24 sm:h-28 sm:w-28"
          />
          <h1 id="hero-heading" className="relative text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Watch videos together
          </h1>
          <p className="relative mt-4 max-w-lg text-base text-neutral-400 sm:text-lg">
            Synchronized playback with friends, wherever they are. YouTube, Twitch, Kick and more than a thousand other sites.
          </p>

          <form onSubmit={createRoom} className="relative mt-8 max-w-lg">
            <label htmlFor="room-name" className="sr-only">
              Room name
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="room-name"
                name="room-name"
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
                placeholder="Room name (optional)"
                autoComplete="off"
                aria-describedby="room-name-hint"
                className="h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-4 text-sm placeholder:text-neutral-500 hover:border-white/20"
              />
              <button
                type="submit"
                onPointerEnter={() => setExcited(true)}
                onPointerLeave={() => setExcited(false)}
                onFocus={() => setExcited(true)}
                onBlur={() => setExcited(false)}
                className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-[color:var(--accent-primary)] px-5 text-sm font-semibold on-accent shadow-md transition-[filter] hover:brightness-110"
              >
                Create room
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <p id="room-name-hint" className="mt-2 text-xs text-neutral-500">
              Letters, numbers, hyphens and underscores. Leave it empty for a random name.
            </p>
          </form>

          <ul className="relative mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-neutral-400">
            {['No sign-up', 'Free', 'Self-hostable'].map((feature) => (
              <li key={feature} className="flex items-center gap-1.5">
                <Check aria-hidden="true" className="h-4 w-4 text-[color:var(--accent-primary)]" />
                {feature}
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="active-rooms-heading"
          className="app-surface flex max-h-[32rem] min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/60"
        >
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/10 pl-4 pr-2">
            <h2 id="active-rooms-heading" className="flex items-center gap-2 text-sm font-semibold">
              Active rooms
              {!loading && !loadError && (
                <span className="ui-numeric rounded-full bg-white/10 px-1.5 text-2xs font-medium text-neutral-300">
                  {numberFormatter.format(rooms.length)}
                </span>
              )}
            </h2>
            <button
              type="button"
              onClick={retry}
              aria-label="Refresh the list of active rooms"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/10 hover:text-white"
            >
              <RefreshCw
                aria-hidden="true"
                className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              />
            </button>
          </div>

          {/* `relative` so the rows' screen-reader text (absolutely positioned)
              scrolls with the list instead of stretching the page. */}
          <div data-testid="active-rooms-list" className="relative min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <ul className="space-y-1" aria-busy="true" aria-label="Loading active rooms">
                {Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
                  <li key={index} className="flex items-center gap-3 rounded-xl p-2.5">
                    <span className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-white/10" />
                    <span className="flex-1 space-y-2">
                      <span className="block h-3 w-2/3 animate-pulse rounded bg-white/10" />
                      <span className="block h-3 w-1/3 animate-pulse rounded bg-white/5" />
                    </span>
                  </li>
                ))}
              </ul>
            ) : loadError ? (
              <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                <Mascot mood="sad" className="h-14 w-14" />
                <p className="text-sm text-neutral-300">{loadError}</p>
                <button
                  type="button"
                  onClick={retry}
                  className="h-8 rounded-lg border border-white/10 px-3 text-xs font-medium text-neutral-300 hover:bg-white/10 hover:text-white"
                >
                  Try again
                </button>
              </div>
            ) : rooms.length > 0 ? (
              <ul className="space-y-1">
                {rooms.map((room) => (
                  <li key={room.id}>
                    <Link
                      href={`/room/${room.id}`}
                      className="group flex items-center gap-3 rounded-xl p-2.5 hover:bg-white/5"
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 group-hover:bg-[color:var(--accent-primary)]"
                      >
                        <Play className="icon-on-surface h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{room.name || room.id}</span>
                        <span className="block truncate text-xs text-neutral-400">
                          {room.current_video || 'Nothing playing'}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-neutral-400">
                        <Users aria-hidden="true" className="h-3.5 w-3.5" />
                        <span className="ui-numeric">{numberFormatter.format(room.active_users)}</span>
                        <span className="sr-only">
                          {room.active_users === 1 ? 'viewer' : 'viewers'}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
                <Mascot mood="sleepy" className="mb-3 h-14 w-14" />
                <p className="text-sm font-medium text-neutral-300">No active rooms</p>
                <p className="mt-1 text-xs text-neutral-500">Create one and it shows up here.</p>
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 px-4 py-3 text-xs text-neutral-500 sm:px-6">
        <span>{APP_NAME}</span>
        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded hover:text-neutral-300"
        >
          Source on GitHub
        </a>
      </footer>
    </div>
  );
}
