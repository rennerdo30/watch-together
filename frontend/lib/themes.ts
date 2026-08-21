/**
 * Foreground classes for text sitting on a filled accent surface. Defined in
 * `app/globals.css`; unlike `text-white` / `text-black` they keep their value
 * when the light colour scheme is active, because the accent underneath them
 * does not change either.
 */
export const ON_ACCENT_LIGHT = 'on-accent-light';
export const ON_ACCENT_DARK = 'on-accent-dark';

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

/**
 * The surfaces are the same cool slate in every theme; only the accent
 * differs.
 *
 * Each theme used to carry its own tinted background — a green-black for the
 * forest one, a red-black for the rose one — which made the app look like six
 * different applications, each tinted a little cheaply. One considered
 * neutral, six considered accents, is both calmer and more coherent, and it
 * lets the video be the only saturated thing on screen.
 *
 * The accents are deliberately off the framework's default steps: Tailwind's
 * 500s are the most-used colours on the web and read as a default rather than
 * as a choice.
 */
const SLATE = {
    // Read from the tokens so the light scheme is a token swap rather than a
    // second set of classes to keep in step.
    bg: 'bg-[color:var(--bg-primary)]',
    header: 'bg-[color:var(--bg-primary)]/92',
    sidebar: 'bg-[color:var(--bg-secondary)]/85',
    bgHex: '#0a0b0d',
    bgSecondaryHex: '#101216',
} as const;

function slateTheme(
    id: string,
    name: string,
    accent: string,
    text: string = ON_ACCENT_LIGHT,
): Theme {
    return {
        id,
        name,
        bg: SLATE.bg,
        header: SLATE.header,
        sidebar: SLATE.sidebar,
        // A static class, not `bg-[${accent}]`: Tailwind can only generate
        // utilities it can see in the source, and an interpolated colour is
        // invisible to it. The value arrives at runtime through the token,
        // which `getThemeCSSVars` writes onto the shell.
        accent: 'bg-[color:var(--accent-primary)]',
        text,
        border: 'border-[color:var(--border-default)]',
        colors: {
            bg: SLATE.bgHex,
            bgSecondary: SLATE.bgSecondaryHex,
            accent,
            accentGlow: hexToGlow(accent, 0.16),
        },
    };
}

export const THEMES: Theme[] = [
    // Red is what "live" already means next to a video, so it does double duty
    // as the primary action and the recording dot.
    slateTheme('signal', 'Signal', '#d93a3a'),
    slateTheme('ember', 'Ember', '#e2703a', ON_ACCENT_DARK),
    slateTheme('tide', 'Tide', '#2e9e8f'),
    slateTheme('iris', 'Iris', '#6366d8'),
    slateTheme('citron', 'Citron', '#b8e02e', ON_ACCENT_DARK),
    // The one theme whose accent is a neutral: `text-black` flips with the
    // colour scheme alongside it, so the two stay in contrast.
    slateTheme('mono', 'Mono', '#f2f4f7', 'text-black'),
];

export const DEFAULT_THEME = THEMES[0]; // Signal

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
        bg: 'bg-[color:var(--bg-primary)]',
        header: 'bg-[color:var(--bg-primary)]/92',
        sidebar: 'bg-[color:var(--bg-secondary)]/85',
        accent: 'bg-[color:var(--accent-primary)]',
        text: ON_ACCENT_LIGHT,
        border: 'border-[color:var(--border-default)]',
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
