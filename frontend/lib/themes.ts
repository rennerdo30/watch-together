export type Theme = {
    name: string;
    id: string;
    bg: string;
    header: string;
    sidebar: string;
    accent: string;
    text: string;
    border: string;
};

export const THEMES: Theme[] = [
    { id: 'zinc', name: 'Carbon Stealth', bg: 'bg-[#050505]', header: 'bg-[#0a0a0a]/95', sidebar: 'bg-[#0a0a0a]/60', accent: 'bg-white', text: 'text-black', border: 'border-white/10' },
    { id: 'violet', name: 'Neon Indigo', bg: 'bg-[#050510]', header: 'bg-[#0a0a1a]/95', sidebar: 'bg-[#0a0a1a]/60', accent: 'bg-indigo-500', text: 'text-white', border: 'border-indigo-500/20' },
    { id: 'emerald', name: 'Cyber Mint', bg: 'bg-[#020804]', header: 'bg-[#041208]/95', sidebar: 'bg-[#041208]/60', accent: 'bg-emerald-500', text: 'text-white', border: 'border-emerald-500/20' },
    { id: 'amber', name: 'Solar Flare', bg: 'bg-[#0a0500]', header: 'bg-[#1a1000]/95', sidebar: 'bg-[#1a1000]/60', accent: 'bg-amber-500', text: 'text-white', border: 'border-amber-500/20' },
    { id: 'crimson', name: 'Red Void', bg: 'bg-[#0a0000]', header: 'bg-[#1a0000]/95', sidebar: 'bg-[#1a0000]/60', accent: 'bg-red-600', text: 'text-white', border: 'border-red-600/20' },
    { id: 'fuchsia', name: 'Synth Pop', bg: 'bg-[#080208]', header: 'bg-[#120412]/95', sidebar: 'bg-[#120412]/60', accent: 'bg-fuchsia-500', text: 'text-white', border: 'border-fuchsia-500/20' },
];

export const DEFAULT_THEME = THEMES[1]; // Neon Indigo
