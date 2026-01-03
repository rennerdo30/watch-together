"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Users, Plus, ArrowRight, Loader2, Sparkles, Globe, MonitorPlay, Zap } from 'lucide-react';
import { fetchRooms } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  const [roomName, setRoomName] = useState('');
  const [rooms, setRooms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

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
    const id = roomName.trim() || Math.random().toString(36).substring(2, 8);
    router.push(`/room/${id}`);
  };

  return (
    <main className="min-h-screen bg-[#050505] text-neutral-300 flex flex-col font-sans selection:bg-indigo-500/30 overflow-x-hidden">
      {/* Background Orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500/10 blur-[120px] rounded-full animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-fuchsia-500/10 blur-[120px] rounded-full animate-pulse delay-700" />
      </div>

      <div className="relative flex-1 flex flex-col lg:flex-row max-w-7xl mx-auto w-full p-6 lg:p-12 gap-12 lg:gap-20 items-center justify-center">

        {/* Left: Hero */}
        <div className="flex-1 space-y-10 py-10 lg:py-0 w-full">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-neutral-900/50 backdrop-blur-md border border-white/5 rounded-full animate-in fade-in slide-in-from-bottom-4 duration-700">
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-[11px] font-black uppercase tracking-widest text-neutral-400">Next-Gen Sync Engine</span>
            </div>

            <h1 className="text-6xl lg:text-8xl font-black text-white tracking-tighter leading-[0.9] animate-in fade-in slide-in-from-bottom-6 duration-1000 delay-100">
              WATCH <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 via-fuchsia-500 to-amber-500">TOGETHER</span>
            </h1>

            <p className="text-xl text-neutral-400 max-w-lg leading-relaxed font-medium animate-in fade-in slide-in-from-bottom-8 duration-1000 delay-200">
              Experience flawless video synchronization with anyone, anywhere. High-density, zero-latency, and built for the modern web.
            </p>

            <form onSubmit={createRoom} className="flex flex-col sm:flex-row gap-3 max-w-xl pt-6 animate-in fade-in slide-in-from-bottom-10 duration-1000 delay-300">
              <div className="relative flex-1 group">
                <div className="absolute inset-0 bg-indigo-500/20 blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity" />
                <Plus className="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-500 group-focus-within:text-indigo-400 transition-colors" />
                <input
                  value={roomName}
                  onChange={e => setRoomName(e.target.value)}
                  placeholder="CREATE OR JOIN BY NAME..."
                  className="relative w-full h-16 bg-neutral-900/80 backdrop-blur-xl border border-white/5 rounded-2xl pl-14 pr-6 text-sm font-black tracking-widest text-white placeholder:text-neutral-700 focus:outline-none focus:border-indigo-500/50 transition-all uppercase"
                />
              </div>
              <button
                type="submit"
                className="relative h-16 px-10 bg-white hover:bg-neutral-200 text-black font-black rounded-2xl text-sm tracking-widest uppercase transition-all active:scale-[0.98] flex items-center justify-center gap-3 overflow-hidden group shadow-[0_0_20px_rgba(255,255,255,0.1)]"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-indigo-500 to-fuchsia-500 opacity-0 group-hover:opacity-10 transition-opacity" />
                {roomName ? 'Create Room' : 'Quick Launch'}
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </button>
            </form>
          </div>

          {/* Stats Bar */}
          <div className="flex flex-wrap gap-8 pt-4 animate-in fade-in slide-in-from-bottom-12 duration-1000 delay-500">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                <Globe className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <p className="text-[10px] font-black text-neutral-600 uppercase">Global</p>
                <p className="text-sm font-bold text-white uppercase tracking-tighter">Presence</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-fuchsia-500/10 border border-fuchsia-500/20 flex items-center justify-center">
                <MonitorPlay className="w-5 h-5 text-fuchsia-400" />
              </div>
              <div>
                <p className="text-[10px] font-black text-neutral-600 uppercase">Multi</p>
                <p className="text-sm font-bold text-white uppercase tracking-tighter">Engine</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                <Zap className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <p className="text-[10px] font-black text-neutral-600 uppercase">Insta</p>
                <p className="text-sm font-bold text-white uppercase tracking-tighter">Sync</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Room List */}
        <div className="w-full lg:w-[440px] flex flex-col bg-neutral-900/40 backdrop-blur-2xl border border-white/5 rounded-[2.5rem] overflow-hidden shadow-2xl animate-in fade-in slide-in-from-right-10 duration-1000">
          <div className="p-8 border-b border-white/5 flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-black text-white tracking-tighter uppercase">Stations</h2>
              <p className="text-xs font-bold text-neutral-500 uppercase tracking-widest mt-1">Live Active Signals</p>
            </div>
            <div className="px-4 py-2 bg-white/5 rounded-2xl border border-white/5">
              <span className="text-sm font-black text-indigo-400">{rooms.length}</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[400px] max-h-[500px] custom-scrollbar">
            {loading ? (
              <div className="h-64 flex flex-col items-center justify-center text-neutral-500 gap-4">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                <span className="text-[11px] font-black uppercase tracking-[0.2em]">Synchronizing...</span>
              </div>
            ) : rooms.length > 0 ? (
              rooms.map((room, idx) => (
                <button
                  key={room.id}
                  onClick={() => router.push(`/room/${room.id}`)}
                  className="w-full text-left p-5 rounded-3xl bg-white/[0.02] border border-white/5 hover:border-indigo-500/30 hover:bg-white/[0.04] transition-all flex items-center gap-5 group animate-in fade-in slide-in-from-bottom-2 duration-500"
                  style={{ animationDelay: `${idx * 100}ms` }}
                >
                  <div className="w-14 h-14 rounded-2xl bg-neutral-900 border border-white/5 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform shadow-lg relative">
                    <Play className="w-6 h-6 text-neutral-400 group-hover:text-indigo-400 transition-colors fill-current" />
                    {room.active_users > 0 && (
                      <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-green-500 border-4 border-[#050505] animate-pulse" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-lg font-black text-white truncate uppercase tracking-tighter">{room.id}</p>
                    </div>
                    <p className="text-[11px] text-neutral-500 truncate mt-1 font-bold font-mono tracking-tight">
                      {room.current_video || 'AWAITING INPUT...'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="flex items-center gap-2 text-indigo-400 bg-indigo-500/10 px-3 py-1.5 rounded-xl border border-indigo-500/20">
                      <Users className="w-3.5 h-3.5" />
                      <span className="text-xs font-black">{room.active_users}</span>
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <div className="h-64 flex flex-col items-center justify-center text-neutral-700 gap-5 grayscale opacity-50">
                <Play className="w-16 h-16" />
                <div className="text-center">
                  <p className="text-sm font-black uppercase tracking-widest">No Signals Found</p>
                  <p className="text-[11px] font-bold mt-2 uppercase">Establish the first room</p>
                </div>
              </div>
            )}
          </div>

          <div className="p-6 bg-indigo-500/[0.02] border-t border-white/5">
            <div className="flex items-center justify-between text-[10px] font-black text-neutral-600 uppercase tracking-widest px-2">
              <span>SECURE_AUTH_ACTIVE</span>
              <span>v1.0.4-BETA</span>
            </div>
          </div>
        </div>
      </div>

      <footer className="p-10 text-center relative z-10 border-t border-white/5 bg-black/20 backdrop-blur-xl">
        <p className="text-[11px] font-black text-neutral-600 tracking-[0.3em] uppercase">Watch Together &bull; High Frequency Playback</p>
      </footer>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.05); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.1); }
      `}</style>
    </main>
  );
}
