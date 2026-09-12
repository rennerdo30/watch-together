import { displayName } from '@/lib/utils';

export const ROOM_ACTIVITY_LIMIT = 200;

export type RoomActivityAction =
  | 'user_joined'
  | 'user_left'
  | 'queue_added'
  | 'queue_removed'
  | 'queue_pinned'
  | 'queue_unpinned'
  | 'queue_reordered'
  | 'video_started'
  | 'playback_resumed'
  | 'playback_paused'
  | 'playback_seeked'
  | 'video_skipped'
  | 'video_finished'
  | 'playback_stopped'
  | 'role_changed'
  | 'room_permanence_changed'
  | 'room_renamed'
  | 'sponsorblock_changed';

export interface RoomActivityEvent {
  id: string;
  action: RoomActivityAction | (string & {});
  actor: string | null;
  /** Unix timestamp in seconds. */
  created_at: number;
  title?: string;
  original_url?: string;
  /** Queue position, one-based. */
  position?: number;
  target?: string;
  role?: string;
  name?: string;
  enabled?: boolean;
  /** Playback position in seconds. */
  timestamp?: number;
}

export interface ActivityDescription {
  actor?: { label: string; identity: string };
  text: string;
  detail?: string;
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** Parse the server boundary defensively; persisted room data may predate this feature. */
export function parseRoomActivity(value: unknown): RoomActivityEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id || typeof item.action !== 'string' || !item.action) return;
  if (typeof item.created_at !== 'number' || !Number.isFinite(item.created_at)) return;

  const event: RoomActivityEvent = {
    id: item.id,
    action: item.action,
    actor: typeof item.actor === 'string' && item.actor ? item.actor : null,
    created_at: item.created_at,
  };
  for (const key of ['title', 'original_url', 'target', 'role', 'name'] as const) {
    const parsed = optionalString(item[key]);
    if (parsed) event[key] = parsed;
  }
  if (typeof item.position === 'number' && Number.isFinite(item.position)) event.position = item.position;
  if (typeof item.timestamp === 'number' && Number.isFinite(item.timestamp)) event.timestamp = item.timestamp;
  if (typeof item.enabled === 'boolean') event.enabled = item.enabled;
  return event;
}

/** Return a deduplicated, newest-first activity window. */
export function normalizeRoomActivity(value: unknown): RoomActivityEvent[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, RoomActivityEvent>();
  for (const raw of value) {
    const event = parseRoomActivity(raw);
    if (event && !byId.has(event.id)) byId.set(event.id, event);
  }
  return [...byId.values()]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, ROOM_ACTIVITY_LIMIT);
}

/** Merge a live event into history without duplicating reconnect/broadcast races. */
export function mergeRoomActivity(
  history: RoomActivityEvent[],
  value: unknown,
): RoomActivityEvent[] {
  const event = parseRoomActivity(value);
  if (!event) return history;
  return normalizeRoomActivity([event, ...history]);
}

export function formatPlaybackTime(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0:00';
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const roleLabel = (role: string | undefined): string => {
  if (!role) return 'a new role';
  return role === 'moderator' ? 'a moderator' : role === 'admin' ? 'an admin' : 'a viewer';
};

/** Human-readable copy kept separate from rendering so every client uses the same wording. */
export function describeRoomActivity(event: RoomActivityEvent): ActivityDescription {
  const actor = event.actor
    ? { label: displayName(event.actor), identity: event.actor }
    : undefined;
  const who = actor?.label ?? 'System';
  const target = event.target ? displayName(event.target) : 'a member';
  const detail = event.title ? `“${event.title}”` : undefined;

  switch (event.action) {
    case 'user_joined': return { actor, text: `${who} joined the room` };
    case 'user_left': return { actor, text: `${who} left the room` };
    case 'queue_added': return { actor, text: `${who} added a video to the queue`, detail };
    case 'queue_removed': return { actor, text: `${who} removed a video from the queue`, detail };
    case 'queue_pinned': return { actor, text: `${who} pinned a video`, detail };
    case 'queue_unpinned': return { actor, text: `${who} unpinned a video`, detail };
    case 'queue_reordered':
      return {
        actor,
        text: `${who} moved a video${event.position ? ` to position ${event.position}` : ''}`,
        detail,
      };
    case 'video_started': return { actor, text: `${who} started a video`, detail };
    case 'playback_resumed': return { actor, text: `${who} resumed playback`, detail };
    case 'playback_paused': return { actor, text: `${who} paused playback`, detail };
    case 'playback_seeked':
      return { actor, text: `${who} seeked to ${formatPlaybackTime(event.timestamp)}`, detail };
    case 'video_skipped': return { actor, text: `${who} skipped a video`, detail };
    case 'video_finished': return { text: 'Video finished', detail };
    case 'playback_stopped': return { text: 'Playback stopped — queue finished' };
    case 'role_changed':
      return { actor, text: `${who} made ${target} ${roleLabel(event.role)}` };
    case 'room_permanence_changed':
      return { actor, text: `${who} made the room ${event.enabled ? 'permanent' : 'temporary'}` };
    case 'room_renamed':
      return { actor, text: `${who} renamed the room`, detail: event.name ? `“${event.name}”` : 'Room name removed' };
    case 'sponsorblock_changed': return { actor, text: `${who} changed SponsorBlock settings` };
    default: {
      const action = event.action.replaceAll('_', ' ').trim() || 'updated the room';
      return { actor, text: `${who} ${action}`, detail };
    }
  }
}
