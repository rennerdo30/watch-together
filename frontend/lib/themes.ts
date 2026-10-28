/**
 * Accent themes.
 *
 * The surfaces are the same cool slate in every theme; only the accent
 * differs. An accent has two variants, one per colour scheme: the colour a
 * dark page can carry as text (bright) is not one a light page can (it washes
 * out), and a filled button needs a foreground that reads on each. So every
 * theme names both fills and the ink drawn on them.
 *
 * The theme is applied by writing four custom properties on <html>
 * (`applyAccentTheme`); `app/globals.css` picks the pair for the active
 * scheme. `ACCENT_BOOTSTRAP_SCRIPT` does the same before first paint.
 *
 * Teal is the default and the brand colour: the sites this app plays are red
 * (YouTube) and purple (Twitch), and borrowing either reads as theirs.
 */

export type AccentVariant = {
    /** Fill of primary buttons, selected states, links, the progress bar. */
    accent: string;
    /** Text and icons drawn on that fill. */
    on: string;
};

export type Theme = {
    id: string;
    name: string;
    dark: AccentVariant;
    light: AccentVariant;
};

export const THEME_STORAGE_KEY = 'wt_theme';
export const CUSTOM_THEME_STORAGE_KEY = 'wt_custom_theme';
export const CUSTOM_THEME_ID = 'custom';

const INK = '#ffffff';

export const THEMES: Theme[] = [
    { id: 'tide', name: 'Tide', dark: { accent: '#2fc4b2', on: '#04201c' }, light: { accent: '#0f766e', on: INK } },
    { id: 'ember', name: 'Ember', dark: { accent: '#f08a4b', on: '#1f0d02' }, light: { accent: '#c2510c', on: INK } },
    { id: 'iris', name: 'Iris', dark: { accent: '#8b8ff0', on: '#0b0b2a' }, light: { accent: '#4f46e5', on: INK } },
    { id: 'citron', name: 'Citron', dark: { accent: '#c6e33a', on: '#1a2000' }, light: { accent: '#4d7c0f', on: INK } },
    { id: 'signal', name: 'Signal', dark: { accent: '#f06262', on: '#2a0505' }, light: { accent: '#c62f2f', on: INK } },
    // A neutral accent: ink on the page, the page's colour on the fill.
    { id: 'mono', name: 'Mono', dark: { accent: '#f2f4f7', on: '#0a0b0d' }, light: { accent: '#15181c', on: INK } },
];

export const DEFAULT_THEME = THEMES[0];

export function getThemeById(id: string): Theme | undefined {
    return THEMES.find(t => t.id === id);
}

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

function channels(hex: string): [number, number, number] {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
    return `#${[r, g, b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
    const [r, g, b] = channels(hex).map(c => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** Body text contrast (WCAG AA). */
const MIN_CONTRAST = 4.5;
const LIGHT_PAGE = '#f8f9fa';
const DARK_INK = '#0a0b0d';
const DARKEN_STEP = 0.06;

function darken(hex: string, amount: number): string {
    const [r, g, b] = channels(hex);
    return toHex([r * (1 - amount), g * (1 - amount), b * (1 - amount)]);
}

/**
 * A theme from one picked colour. The dark scheme uses it as picked, with
 * whichever ink reads on it; the light scheme darkens it until it reads on the
 * light page and carries white text.
 */
export function createCustomTheme(accent: string): Theme {
    const base = HEX_PATTERN.test(accent) ? accent.toLowerCase() : DEFAULT_THEME.dark.accent;
    const darkOn = contrastRatio(base, DARK_INK) >= contrastRatio(base, INK) ? DARK_INK : INK;
    let light = base;
    for (let amount = DARKEN_STEP; contrastRatio(light, LIGHT_PAGE) < MIN_CONTRAST && amount < 1; amount += DARKEN_STEP) {
        light = darken(base, amount);
    }
    return { id: CUSTOM_THEME_ID, name: 'Custom', dark: { accent: base, on: darkOn }, light: { accent: light, on: INK } };
}

export function isTheme(value: unknown): value is Theme {
    const theme = value as Theme;
    const variant = (v: AccentVariant | undefined) => Boolean(v && HEX_PATTERN.test(v.accent) && HEX_PATTERN.test(v.on));
    return Boolean(theme && typeof theme.id === 'string' && variant(theme.dark) && variant(theme.light));
}

export const ACCENT_PROPERTIES = {
    darkAccent: '--theme-accent-dark',
    darkOn: '--theme-on-dark',
    lightAccent: '--theme-accent-light',
    lightOn: '--theme-on-light',
} as const;

export function applyAccentTheme(theme: Theme): void {
    if (typeof document === 'undefined') return;
    const style = document.documentElement.style;
    style.setProperty(ACCENT_PROPERTIES.darkAccent, theme.dark.accent);
    style.setProperty(ACCENT_PROPERTIES.darkOn, theme.dark.on);
    style.setProperty(ACCENT_PROPERTIES.lightAccent, theme.light.accent);
    style.setProperty(ACCENT_PROPERTIES.lightOn, theme.light.on);
}

/**
 * Applies the stored theme before first paint, so a room never flashes the
 * default accent. Inlined as a string; failure leaves the CSS defaults.
 */
export const ACCENT_BOOTSTRAP_SCRIPT = `(function(){try{
var T=${JSON.stringify(Object.fromEntries(THEMES.map(t => [t.id, t])))};
var id=localStorage.getItem('${THEME_STORAGE_KEY}');var t=T[id];
if(id==='${CUSTOM_THEME_ID}'){t=JSON.parse(localStorage.getItem('${CUSTOM_THEME_STORAGE_KEY}')||'null');}
if(!t||!t.dark||!t.light)return;var s=document.documentElement.style;
s.setProperty('${ACCENT_PROPERTIES.darkAccent}',t.dark.accent);s.setProperty('${ACCENT_PROPERTIES.darkOn}',t.dark.on);
s.setProperty('${ACCENT_PROPERTIES.lightAccent}',t.light.accent);s.setProperty('${ACCENT_PROPERTIES.lightOn}',t.light.on);
}catch(e){}})();`;
