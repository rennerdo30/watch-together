"use client";

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, Play, Plus, RefreshCw, Tv, Users, Video } from 'lucide-react';
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
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600"
          >
            <Tv className="h-5 w-5 on-accent-light" />
          </span>
          <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
        </div>
        <div className="flex items-center gap-4">
          {!loading && !loadError && (
            <p className="flex items-center gap-2 text-sm text-neutral-400">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-500" />
              {totalUsers === 1
                ? '1 viewer online'
                : `${numberFormatter.format(totalUsers)} viewers online`}
            </p>
          )}
          <ColorModeToggle />
        </div>
      </header>

      <div className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
        <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-8 sm:py-16">
          <div className="w-full max-w-md space-y-8">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                Watch videos together
              </h1>
              <p className="text-base text-neutral-400 sm:text-lg">
                Synchronized playback with friends. YouTube, Twitch, and more.
              </p>
            </div>

            <form onSubmit={createRoom} className="space-y-3">
              <div>
                <label htmlFor="room-name" className="sr-only">
                  Room name
                </label>
                <div className="relative">
                  <Plus
                    aria-hidden="true"
                    className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-neutral-500"
                  />
                  <input
                    id="room-name"
                    name="room-name"
                    value={roomName}
                    onChange={(event) => setRoomName(event.target.value)}
                    placeholder="Room name (optional)"
                    autoComplete="off"
                    aria-describedby="room-name-hint"
                    className="h-14 w-full rounded-xl border border-neutral-700 bg-neutral-900 pl-12 pr-4 text-base placeholder:text-neutral-500 hover:border-neutral-600 focus:border-violet-500"
                  />
                </div>
                <p id="room-name-hint" className="mt-2 text-xs text-neutral-500">
                  Letters, numbers, hyphens and underscores. Leave empty for a random room.
                </p>
              </div>
              <button
                type="submit"
                className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 text-base font-semibold on-accent-light shadow-lg shadow-violet-600/20 hover:bg-violet-500"
              >
                Create room
                <ArrowRight aria-hidden="true" className="h-5 w-5" />
              </button>
            </form>

            <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-neutral-400">
              <li>No sign up required</li>
              <li>Free forever</li>
              <li>Self-hostable</li>
            </ul>
          </div>
        </main>

        <aside
          aria-labelledby="active-rooms-heading"
          className="app-surface flex w-full flex-col border-t border-white/10 bg-neutral-900/50 lg:w-96 lg:border-l lg:border-t-0"
        >
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-5">
            <h2 id="active-rooms-heading" className="text-sm font-semibold">
              Active rooms
            </h2>
            <div className="flex items-center gap-2">
              {!loading && !loadError && (
                <span className="text-sm text-violet-400">
                  {numberFormatter.format(rooms.length)}
                </span>
              )}
              <button
                type="button"
                onClick={retry}
                aria-label="Refresh the list of active rooms"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-white/10 hover:text-white"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
                />
              </button>
            </div>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto p-4 lg:min-h-0">
            {loading ? (
              <ul className="space-y-2" aria-busy="true" aria-label="Loading active rooms">
                {Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
                  <li
                    key={index}
                    className="flex items-center gap-4 rounded-xl bg-white/5 p-4"
                  >
                    <span className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-white/10" />
                    <span className="flex-1 space-y-2">
                      <span className="block h-3 w-2/3 animate-pulse rounded bg-white/10" />
                      <span className="block h-3 w-1/3 animate-pulse rounded bg-white/5" />
                    </span>
                  </li>
                ))}
              </ul>
            ) : loadError ? (
              <div
                role="alert"
                className="flex flex-col items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-10 text-center"
              >
                <AlertTriangle aria-hidden="true" className="h-5 w-5 text-amber-400" />
                <p className="text-sm text-neutral-300">{loadError}</p>
                <button
                  type="button"
                  onClick={retry}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-white/10 hover:text-white"
                >
                  Try again
                </button>
              </div>
            ) : rooms.length > 0 ? (
              <ul className="space-y-2">
                {rooms.map((room) => (
                  <li key={room.id}>
                    <Link
                      href={`/room/${room.id}`}
                      className="group flex items-center gap-4 rounded-xl bg-white/5 p-4 hover:bg-white/10"
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 group-hover:bg-violet-600"
                      >
                        <Play className="icon-on-surface h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{room.id}</span>
                        <span className="block truncate text-sm text-neutral-400">
                          {room.current_video || 'No video playing'}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5 text-sm text-neutral-400">
                        <Users aria-hidden="true" className="h-4 w-4" />
                        {numberFormatter.format(room.active_users)}
                        <span className="sr-only">
                          {room.active_users === 1 ? 'viewer' : 'viewers'}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                <span
                  aria-hidden="true"
                  className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-white/5"
                >
                  <Video className="h-5 w-5 text-neutral-400" />
                </span>
                <p className="text-sm font-medium text-neutral-300">No active rooms</p>
                <p className="mt-1 text-sm text-neutral-500">Create one to get started</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 px-4 py-3 text-sm text-neutral-500 sm:px-6">
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
