export type Theme = {
    id: string;
    name: string;
    // CSS class-based (for Tailwind)
    bg: string;
    header: string;
    sidebar: string;
    accent: string;
    text: string;
    border: string;
    // Hex values for custom color picker and CSS vars
    colors: {
        bg: string;
        bgSecondary: string;
        accent: string;
        accentGlow: string;
    };
};

export type CustomTheme = {
    id: 'custom';
    name: string;
    colors: {
        bg: string;
        bgSecondary: string;
        accent: string;
    };
};

export const THEMES: Theme[] = [
    {
        id: 'obsidian',
        name: 'Obsidian',
        bg: 'bg-[#09090b]',
        header: 'bg-[#09090b]/95',
        sidebar: 'bg-[#0f0f12]/80',
        accent: 'bg-violet-500',
        text: 'text-white',
        border: 'border-white/10',
        colors: {
            bg: '#09090b',
            bgSecondary: '#0f0f12',
            accent: '#8b5cf6',
            accentGlow: 'rgba(139, 92, 246, 0.15)',
        }
    },
    {
        id: 'midnight',
        name: 'Midnight',
        bg: 'bg-[#0a0a14]',
        header: 'bg-[#0a0a14]/95',
        sidebar: 'bg-[#0f0f1a]/80',
        accent: 'bg-blue-500',
        text: 'text-white',
        border: 'border-blue-500/15',
        colors: {
            bg: '#0a0a14',
            bgSecondary: '#0f0f1a',
            accent: '#3b82f6',
            accentGlow: 'rgba(59, 130, 246, 0.15)',
        }
    },
    {
        id: 'emerald',
        name: 'Forest',
        bg: 'bg-[#080c08]',
        header: 'bg-[#080c08]/95',
        sidebar: 'bg-[#0a120a]/80',
        accent: 'bg-emerald-500',
        text: 'text-white',
        border: 'border-emerald-500/15',
        colors: {
            bg: '#080c08',
            bgSecondary: '#0a120a',
            accent: '#10b981',
            accentGlow: 'rgba(16, 185, 129, 0.15)',
        }
    },
    {
        id: 'rose',
        name: 'Rose',
        bg: 'bg-[#0c0808]',
        header: 'bg-[#0c0808]/95',
        sidebar: 'bg-[#120a0a]/80',
        accent: 'bg-rose-500',
        text: 'text-white',
        border: 'border-rose-500/15',
        colors: {
            bg: '#0c0808',
            bgSecondary: '#120a0a',
            accent: '#f43f5e',
            accentGlow: 'rgba(244, 63, 94, 0.15)',
        }
    },
    {
        id: 'amber',
        name: 'Solar',
        bg: 'bg-[#0c0a06]',
        header: 'bg-[#0c0a06]/95',
        sidebar: 'bg-[#12100a]/80',
        accent: 'bg-amber-500',
        text: 'text-black',
        border: 'border-amber-500/15',
        colors: {
            bg: '#0c0a06',
            bgSecondary: '#12100a',
            accent: '#f59e0b',
            accentGlow: 'rgba(245, 158, 11, 0.15)',
        }
    },
    {
        id: 'mono',
        name: 'Mono',
        bg: 'bg-[#0a0a0a]',
        header: 'bg-[#0a0a0a]/95',
        sidebar: 'bg-[#111111]/80',
        accent: 'bg-white',
        text: 'text-black',
        border: 'border-white/10',
        colors: {
            bg: '#0a0a0a',
            bgSecondary: '#111111',
            accent: '#ffffff',
            accentGlow: 'rgba(255, 255, 255, 0.08)',
        }
    },
];

export const DEFAULT_THEME = THEMES[0]; // Obsidian

// Helper to get theme by ID
export function getThemeById(id: string): Theme | undefined {
    return THEMES.find(t => t.id === id);
}

// Helper to create CSS variables from theme
export function getThemeCSSVars(theme: Theme | CustomTheme): Record<string, string> {
    if ('colors' in theme) {
        return {
            '--accent-primary': theme.colors.accent,
            '--accent-glow': 'accentGlow' in theme.colors ? theme.colors.accentGlow : `${theme.colors.accent}26`,
            '--bg-primary': theme.colors.bg,
            '--bg-secondary': theme.colors.bgSecondary,
        };
    }
    return {};
}

// Helper to generate accent glow from hex color
export function hexToGlow(hex: string, opacity: number = 0.15): string {
    // Remove # if present
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// Create a custom theme from colors
export function createCustomTheme(name: string, bgColor: string, accentColor: string): Theme {
    // Derive secondary bg by lightening slightly
    const darkenHex = (hex: string, amount: number): string => {
        hex = hex.replace('#', '');
        const r = Math.max(0, parseInt(hex.substring(0, 2), 16) + amount);
        const g = Math.max(0, parseInt(hex.substring(2, 4), 16) + amount);
        const b = Math.max(0, parseInt(hex.substring(4, 6), 16) + amount);
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    };

    const bgSecondary = darkenHex(bgColor, 8);

    return {
        id: 'custom',
        name: name || 'Custom',
        bg: `bg-[${bgColor}]`,
        header: `bg-[${bgColor}]/95`,
        sidebar: `bg-[${bgSecondary}]/80`,
        accent: `bg-[${accentColor}]`,
        text: 'text-white',
        border: `border-[${accentColor}]/15`,
        colors: {
            bg: bgColor,
            bgSecondary: bgSecondary,
            accent: accentColor,
            accentGlow: hexToGlow(accentColor),
        }
    };
}

// Load custom theme from localStorage
export function loadCustomTheme(): Theme | null {
    if (typeof window === 'undefined') return null;
    const stored = localStorage.getItem('wt_custom_theme');
    if (!stored) return null;
    try {
        return JSON.parse(stored) as Theme;
    } catch {
        return null;
    }
}

// Save custom theme to localStorage
export function saveCustomTheme(theme: Theme): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem('wt_custom_theme', JSON.stringify(theme));
}
