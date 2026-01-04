"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Users, Plus, ArrowRight, Loader2, Tv, Video } from 'lucide-react';
import { fetchRooms } from '@/lib/api';

interface Room {
  id: string;
  active_users: number;
  current_video?: string;
  queue_size: number;
}

export default function Home() {
  const router = useRouter();
  const [roomName, setRoomName] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [isHovering, setIsHovering] = useState<string | null>(null);

  useEffect(() => {
    const loadRooms = async () => {
      try {
        const data = await fetchRooms();
        setRooms(data);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    loadRooms();
    const interval = setInterval(loadRooms, 10000);
    return () => clearInterval(interval);
  }, []);

  const createRoom = (e?: React.FormEvent) => {
    e?.preventDefault();
    const sanitized = roomName.trim().replace(/[^a-zA-Z0-9-_]/g, '');
    const id = sanitized || Math.random().toString(36).substring(2, 8);
    router.push(`/room/${id}`);
  };

  const totalUsers = rooms.reduce((sum, r) => sum + r.active_users, 0);

  return (
    <main className="min-h-screen bg-[#0a0a0c] text-white flex flex-col">
      {/* Header */}
      <header className="h-14 border-b border-white/5 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
            <Tv className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-base">Watch Together</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <div className="w-2 h-2 rounded-full bg-emerald-500" />
          <span>{totalUsers} online</span>
        </div>
      </header>

      {/* Main */}
      <div className="flex-1 flex">
        {/* Left - Create Room */}
        <div className="flex-1 flex items-center justify-center p-12">
          <div className="max-w-md w-full space-y-8">
            <div>
              <h1 className="text-4xl font-bold tracking-tight">
                Watch videos together
              </h1>
              <p className="text-zinc-400 mt-3 text-lg">
                Synchronized playback with friends. YouTube, Twitch, and more.
              </p>
            </div>

            <form onSubmit={createRoom} className="space-y-4">
              <div className="relative">
                <Plus className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-600" />
                <input
                  value={roomName}
                  onChange={e => setRoomName(e.target.value)}
                  placeholder="Room name (optional)"
                  className="w-full h-14 bg-zinc-900 border border-zinc-800 rounded-xl pl-12 pr-4 text-base placeholder:text-zinc-600 focus:outline-none focus:border-violet-500 transition-colors"
                />
              </div>
              <button
                type="submit"
                className="w-full h-14 bg-violet-600 hover:bg-violet-500 text-white font-semibold rounded-xl text-base transition-colors flex items-center justify-center gap-2"
              >
                Create Room
                <ArrowRight className="w-5 h-5" />
              </button>
            </form>

            <div className="flex items-center gap-6 text-sm text-zinc-500 pt-4">
              <span>✓ No sign up required</span>
              <span>✓ Free forever</span>
            </div>
          </div>
        </div>

        {/* Right - Room List */}
        <div className="w-96 border-l border-zinc-800 flex flex-col bg-zinc-900/50">
          <div className="h-14 px-5 border-b border-zinc-800 flex items-center justify-between shrink-0">
            <span className="font-semibold">Active Rooms</span>
            <span className="text-sm text-violet-400">{rooms.length}</span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-zinc-600" />
              </div>
            ) : rooms.length > 0 ? (
              rooms.map((room) => (
                <button
                  key={room.id}
                  onClick={() => router.push(`/room/${room.id}`)}
                  onMouseEnter={() => setIsHovering(room.id)}
                  onMouseLeave={() => setIsHovering(null)}
                  className={`w-full text-left p-4 rounded-xl transition-colors ${isHovering === room.id
                      ? 'bg-zinc-800'
                      : 'bg-zinc-800/50 hover:bg-zinc-800'
                    }`}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isHovering === room.id ? 'bg-violet-600' : 'bg-zinc-700'
                      }`}>
                      <Play className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{room.id}</p>
                      <p className="text-sm text-zinc-500 truncate">
                        {room.current_video || 'No video playing'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm text-zinc-400">
                      <Users className="w-4 h-4" />
                      <span>{room.active_users}</span>
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-12 h-12 rounded-xl bg-zinc-800 flex items-center justify-center mb-4">
                  <Video className="w-5 h-5 text-zinc-600" />
                </div>
                <p className="text-zinc-500">No active rooms</p>
                <p className="text-sm text-zinc-600 mt-1">Create one to get started</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="h-12 px-6 border-t border-zinc-800 flex items-center justify-between text-sm text-zinc-600 shrink-0">
        <span>Watch Together</span>
        <span>v1.1.0</span>
      </footer>
    </main>
  );
}
