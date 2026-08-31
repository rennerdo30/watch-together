"use client";

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  Database,
  HardDrive,
  ListVideo,
  MemoryStick,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Tv,
  Users,
  X,
} from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';
import {
  ApiError,
  type AdminCacheReport,
  type AdminOverview,
  clearAdminCache,
  closeAdminRoom,
  fetchAdminCache,
  fetchAdminOverview,
} from '@/lib/api';
import { APP_NAME } from '@/lib/constants';
import { ColorModeToggle } from '@/components/color-mode-toggle';

const REFRESH_INTERVAL_MS = 10_000;
const SEGMENT_ROWS_SHOWN = 10;
const FORMAT_URL_MAX_LENGTH = 60;

const numberFormatter = new Intl.NumberFormat();

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours < 24) return `${hours}h ${minutes}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/5 p-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-lg font-semibold leading-tight">{value}</span>
        <span className="block truncate text-xs text-neutral-400">{label}</span>
      </span>
    </div>
  );
}

function UsageBar({ used, budget }: { used: number; budget: number }) {
  const percent = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full bg-[color:var(--accent-primary)]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function SectionCard({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="ui-heading flex items-center gap-2 text-neutral-300">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ClearButton({ label, onClear }: { label: string; onClear: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(`${label}?`)) return;
        setBusy(true);
        try {
          await onClear();
        } finally {
          setBusy(false);
        }
      }}
      className="flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50"
    >
      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export default function AdminPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [cache, setCache] = useState<AdminCacheReport | null>(null);
  const [denied, setDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [ov, ca] = await Promise.all([fetchAdminOverview(), fetchAdminCache()]);
      setOverview(ov);
      setCache(ca);
      setDenied(false);
      setLoadError(null);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setDenied(true);
      } else {
        setLoadError(error instanceof Error ? error.message : 'The admin data could not be loaded.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      try {
        await action();
        toast.success(success);
        await load();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'The action failed.');
      }
    },
    [load],
  );

  if (denied) {
    return (
      <div className="app-shell flex min-h-dvh flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-white">
        <ShieldAlert aria-hidden="true" className="h-10 w-10 text-amber-400" />
        <h1 className="text-xl font-semibold">Admin access required</h1>
        <p className="max-w-sm text-sm text-neutral-400">
          This page is only available to configured administrators. Your
          verified identity is not on the list.
        </p>
        <Link
          href="/"
          className="rounded-lg border border-white/10 px-4 py-2 text-sm text-neutral-300 hover:bg-white/10 hover:text-white"
        >
          Back to {APP_NAME}
        </Link>
      </div>
    );
  }

  return (
    <div className="app-shell flex min-h-dvh flex-col bg-neutral-950 text-white">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-[color:var(--accent-primary)]"
          >
            <Tv className="icon-on-accent h-5 w-5" />
          </span>
          <h1 className="text-lg font-semibold">
            {APP_NAME} <span className="text-neutral-400">Admin</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              load();
            }}
            aria-label="Refresh"
            className="rounded-lg border border-white/10 p-2 text-neutral-300 hover:bg-white/10 hover:text-white"
          >
            <RefreshCw aria-hidden="true" className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <ColorModeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6 sm:px-6">
        {loadError && (
          <div role="alert" className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
            {loadError}
          </div>
        )}

        {/* Overview */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            icon={<ListVideo aria-hidden="true" className="h-5 w-5" />}
            label="Active rooms"
            value={overview ? numberFormatter.format(overview.totals.rooms) : '—'}
          />
          <StatCard
            icon={<Users aria-hidden="true" className="h-5 w-5" />}
            label="Viewers connected"
            value={overview ? numberFormatter.format(overview.totals.viewers) : '—'}
          />
          <StatCard
            icon={<Activity aria-hidden="true" className="h-5 w-5" />}
            label="Backend uptime"
            value={overview ? formatDuration(overview.uptime_seconds) : '—'}
          />
          <StatCard
            icon={<Database aria-hidden="true" className="h-5 w-5" />}
            label="Users with cookies"
            value={overview ? numberFormatter.format(overview.cookie_users.length) : '—'}
          />
        </div>

        {/* Rooms */}
        <SectionCard title="Rooms" icon={<ListVideo aria-hidden="true" className="h-4 w-4" />}>
          {overview && overview.rooms.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="ui-label text-neutral-500">
                  <tr>
                    <th className="pb-2 pr-4">Room</th>
                    <th className="pb-2 pr-4">Viewers</th>
                    <th className="pb-2 pr-4">Playing</th>
                    <th className="pb-2 pr-4">Queue</th>
                    <th className="pb-2 pr-4">Permanent</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {overview.rooms.map((room) => (
                    <tr key={room.id}>
                      <td className="py-2 pr-4">
                        <Link href={`/room/${room.id}`} className="font-medium hover:underline">
                          {room.name || room.id}
                        </Link>
                        {room.name && <span className="ml-2 text-xs text-neutral-500">{room.id}</span>}
                      </td>
                      <td className="py-2 pr-4" title={room.members.join(', ')}>
                        {numberFormatter.format(room.active_users)}
                      </td>
                      <td className="max-w-[16rem] truncate py-2 pr-4 text-neutral-300">
                        {room.current_video || '—'}
                        {room.is_live && (
                          <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                            Live
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4">{numberFormatter.format(room.queue_size)}</td>
                      <td className="py-2 pr-4">{room.permanent ? 'Yes' : 'No'}</td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            if (!window.confirm(`Close room "${room.name || room.id}" and disconnect everyone?`)) return;
                            runAction(() => closeAdminRoom(room.id), `Room ${room.name || room.id} closed`);
                          }}
                          className="flex items-center gap-1 rounded-lg border border-red-500/30 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10"
                        >
                          <X aria-hidden="true" className="h-3 w-3" />
                          Close
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">No rooms right now.</p>
          )}
        </SectionCard>

        {/* Segment cache */}
        <SectionCard
          title="Segment cache (disk)"
          icon={<HardDrive aria-hidden="true" className="h-4 w-4" />}
          action={
            cache && (
              <ClearButton
                label="Clear segment cache"
                onClear={() => runAction(() => clearAdminCache('segments'), 'Segment cache cleared')}
              />
            )
          }
        >
          {cache ? (
            <div className="space-y-4">
              <div>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span>
                    {formatBytes(cache.segments.bytes_total)}{' '}
                    <span className="text-neutral-500">of {formatBytes(cache.segments.budget_bytes)} budget</span>
                  </span>
                  <span className="text-xs text-neutral-500">
                    {numberFormatter.format(cache.segments.entries_total)} entries · oldest{' '}
                    {formatDuration(cache.segments.oldest_age_seconds)} · disk free{' '}
                    {formatBytes(cache.segments.disk_free_bytes)}
                  </span>
                </div>
                <UsageBar used={cache.segments.bytes_total} budget={cache.segments.budget_bytes} />
              </div>
              {cache.segments.entries.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="ui-label text-neutral-500">
                      <tr>
                        <th className="pb-1.5 pr-4">Newest entries</th>
                        <th className="pb-1.5 pr-4">Size</th>
                        <th className="pb-1.5">Age</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 font-mono">
                      {cache.segments.entries.slice(0, SEGMENT_ROWS_SHOWN).map((entry) => (
                        <tr key={entry.name}>
                          <td className="max-w-[24rem] truncate py-1.5 pr-4 text-neutral-400">{entry.name}</td>
                          <td className="py-1.5 pr-4">{formatBytes(entry.bytes)}</td>
                          <td className="py-1.5">{formatDuration(entry.age_seconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {cache.segments.entries.length > SEGMENT_ROWS_SHOWN && (
                    <p className="mt-2 text-xs text-neutral-500">
                      Showing {SEGMENT_ROWS_SHOWN} of {cache.segments.entries.length} listed entries.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-neutral-500">Loading…</p>
          )}
        </SectionCard>

        {/* Memory cache */}
        <SectionCard
          title="Memory cache"
          icon={<MemoryStick aria-hidden="true" className="h-4 w-4" />}
          action={
            cache && (
              <ClearButton
                label="Clear memory cache"
                onClear={() => runAction(() => clearAdminCache('memory'), 'Memory cache cleared')}
              />
            )
          }
        >
          {cache ? (
            <div className="space-y-3">
              <div className="mb-1 flex items-baseline justify-between text-sm">
                <span>
                  {cache.memory.size_mb.toFixed(1)} MB{' '}
                  <span className="text-neutral-500">of {cache.memory.max_mb.toFixed(0)} MB</span>
                </span>
                <span className="text-xs text-neutral-500">
                  {numberFormatter.format(cache.memory.items)} items ({cache.memory.audio_items} audio) ·{' '}
                  {cache.memory.hit_rate_percent}% hit rate ({numberFormatter.format(cache.memory.hits)} hits /{' '}
                  {numberFormatter.format(cache.memory.misses)} misses)
                </span>
              </div>
              <UsageBar used={cache.memory.size_mb} budget={cache.memory.max_mb} />
            </div>
          ) : (
            <p className="text-sm text-neutral-500">Loading…</p>
          )}
        </SectionCard>

        {/* Format cache */}
        <SectionCard
          title="Format cache"
          icon={<Database aria-hidden="true" className="h-4 w-4" />}
          action={
            cache && (
              <ClearButton
                label="Clear format cache"
                onClear={() => runAction(() => clearAdminCache('formats'), 'Format cache cleared')}
              />
            )
          }
        >
          {cache && cache.formats.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="ui-label text-neutral-500">
                  <tr>
                    <th className="pb-2 pr-4">Video</th>
                    <th className="pb-2 pr-4">Type</th>
                    <th className="pb-2 pr-4">Age</th>
                    <th className="pb-2">Expires in</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {cache.formats.map((entry) => (
                    <tr key={entry.original_url}>
                      <td className="max-w-[24rem] py-2 pr-4">
                        <span className="block truncate font-medium">
                          {entry.title || truncateMiddle(entry.original_url, FORMAT_URL_MAX_LENGTH)}
                        </span>
                        <span className="block truncate text-xs text-neutral-500" title={entry.original_url}>
                          {truncateMiddle(entry.original_url, FORMAT_URL_MAX_LENGTH)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-neutral-300">
                        {entry.stream_type || '—'}
                        {entry.is_live && (
                          <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                            Live
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4">{formatDuration(entry.age_seconds)}</td>
                      <td className="py-2">{formatDuration(entry.expires_in_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">
              {cache ? 'No cached format resolutions.' : 'Loading…'}
            </p>
          )}
        </SectionCard>

        {/* Proxy transfers */}
        <SectionCard title="Proxy transfers" icon={<Activity aria-hidden="true" className="h-4 w-4" />}>
          {cache ? (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                {Object.entries(cache.proxy.by_outcome).map(([outcome, count]) => (
                  <span
                    key={outcome}
                    className={`rounded-full px-3 py-1 text-xs ${
                      outcome === 'ok'
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-amber-500/15 text-amber-300'
                    }`}
                  >
                    {outcome}: {numberFormatter.format(count)}
                  </span>
                ))}
                {Object.keys(cache.proxy.by_outcome).length === 0 && (
                  <span className="text-neutral-500">No transfers recorded yet.</span>
                )}
              </div>
              {Object.keys(cache.proxy.by_host).length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="ui-label text-neutral-500">
                      <tr>
                        <th className="pb-1.5 pr-4">Upstream host</th>
                        <th className="pb-1.5">Requests by outcome</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {Object.entries(cache.proxy.by_host).map(([host, stats]) => (
                        <tr key={host}>
                          <td className="max-w-[20rem] truncate py-1.5 pr-4 font-mono text-neutral-400">{host}</td>
                          <td className="py-1.5 text-neutral-300">
                            {Object.entries(stats)
                              .map(([key, value]) => `${key} ${numberFormatter.format(value)}`)
                              .join(' · ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-neutral-500">
                {cache.proxy.recent_failures.length} failures in the last{' '}
                {numberFormatter.format(cache.proxy.recent_samples.length)} recorded transfers.
              </p>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">Loading…</p>
          )}
        </SectionCard>
      </main>
      <Toaster position="bottom-right" toastOptions={{ style: { background: '#262626', color: '#fff' } }} />
    </div>
  );
}
