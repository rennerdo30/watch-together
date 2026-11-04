/**
 * Pieces shared by the store images (render.spec.ts) and the website's
 * screenshots (site.spec.ts).
 */

export const TEAL_FROM = '#34cdb9';
export const TEAL_TO = '#0e8f7d';

// The mascot from components/mascot.tsx, idle, as static markup.
export const MASCOT = `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${TEAL_FROM}"/><stop offset="1" stop-color="${TEAL_TO}"/></linearGradient></defs>
<ellipse cx="40" cy="75" rx="17" ry="2.6" fill="#000" opacity=".25"/>
<g stroke="url(#m)" stroke-width="2.6" stroke-linecap="round"><path d="M33 15 25.5 4.5"/><path d="M47 15 54.5 4.5"/></g>
<circle cx="25" cy="4" r="2.6" fill="${TEAL_FROM}"/><circle cx="55" cy="4" r="2.6" fill="${TEAL_FROM}"/>
<rect x="36" y="56" width="8" height="9" rx="2" fill="${TEAL_TO}"/><path d="M30 67h20" stroke="${TEAL_TO}" stroke-width="5" stroke-linecap="round"/>
<rect x="7" y="14" width="66" height="45" rx="14" fill="url(#m)"/><rect x="12.5" y="19.5" width="55" height="34" rx="9.5" fill="#effcf9"/>
<ellipse cx="31" cy="36" rx="3.6" ry="5.2" fill="#0b4f46"/><ellipse cx="49" cy="36" rx="3.6" ry="5.2" fill="#0b4f46"/></svg>`;

// A calm evening landscape standing in for the video, so the screenshot shows
// a picture rather than the test card the fixture stream carries.
export const SCENE = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice'>
<defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#1b2a4a'/><stop offset='.55' stop-color='#c2607a'/><stop offset='.8' stop-color='#f3a861'/></linearGradient></defs>
<rect width='1600' height='900' fill='url(#s)'/><circle cx='1080' cy='560' r='90' fill='#ffd9a0' opacity='.9'/>
<path d='M0 620 260 430 470 560 700 380 980 600 1230 450 1600 640V900H0Z' fill='#4a3557'/>
<path d='M0 720 300 560 560 690 820 540 1100 700 1380 580 1600 700V900H0Z' fill='#2c2240'/>
<path d='M0 800 400 690 760 790 1120 680 1600 790V900H0Z' fill='#17142a'/></svg>`)}")`;
