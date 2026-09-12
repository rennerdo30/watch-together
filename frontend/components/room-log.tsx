'use client';

import {
  ArrowUpDown,
  CirclePause,
  CirclePlay,
  History,
  ListMinus,
  ListPlus,
  Pin,
  PinOff,
  Settings2,
  SkipForward,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import {
  describeRoomActivity,
  type RoomActivityEvent,
} from '@/lib/room-log';

const actionIcons: Record<string, LucideIcon> = {
  user_joined: UserRound,
  user_left: UserRound,
  queue_added: ListPlus,
  queue_removed: ListMinus,
  queue_pinned: Pin,
  queue_unpinned: PinOff,
  queue_reordered: ArrowUpDown,
  video_started: CirclePlay,
  playback_resumed: CirclePlay,
  playback_paused: CirclePause,
  playback_seeked: SkipForward,
  video_skipped: SkipForward,
  video_finished: CirclePause,
  playback_stopped: CirclePause,
};

function ActivityRow({ event }: { event: RoomActivityEvent }) {
  const description = describeRoomActivity(event);
  const Icon = actionIcons[event.action] ?? Settings2;
  const date = new Date(event.created_at * 1000);
  const validDate = !Number.isNaN(date.getTime());
  const fullDate = validDate ? date.toLocaleString() : '';
  const shortTime = validDate
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <li className="flex gap-2.5 px-3 py-2.5 border-b border-neutral-800/70 last:border-b-0">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-neutral-800 text-neutral-400"
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs leading-5 text-neutral-300">
            {description.actor ? (
              <>
                <span className="font-semibold text-neutral-100" title={description.actor.identity}>
                  {description.actor.label}
                </span>
                {description.text.slice(description.actor.label.length)}
              </>
            ) : description.text}
          </p>
          {validDate && (
            <time
              dateTime={date.toISOString()}
              title={fullDate}
              className="shrink-0 pt-0.5 text-[10px] tabular-nums text-neutral-500"
            >
              {shortTime}
            </time>
          )}
        </div>
        {description.detail && (
          <p className="mt-0.5 break-words text-[11px] leading-4 text-neutral-500">
            {description.detail}
          </p>
        )}
      </div>
    </li>
  );
}

export function RoomLog({ events }: { events: RoomActivityEvent[] }) {
  return (
    <section aria-labelledby="room-log-heading" className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-800 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <History aria-hidden="true" className="size-3.5 text-neutral-500" />
          <h2 id="room-log-heading" className="text-xs font-semibold text-neutral-200">Room log</h2>
        </div>
        <p className="mt-1 text-[10px] text-neutral-500">Latest 200 events · newest first.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
        {events.length ? (
          <ol aria-label="Room activity, newest first">
            {events.map((event) => <ActivityRow key={event.id} event={event} />)}
          </ol>
        ) : (
          <p className="px-4 py-10 text-center text-xs leading-5 text-neutral-400">
            No room activity yet. Queue and playback changes will appear here.
          </p>
        )}
      </div>
    </section>
  );
}
