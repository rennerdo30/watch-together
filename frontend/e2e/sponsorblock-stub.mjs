/**
 * A stand-in for the SponsorBlock API, started by the Playwright config.
 *
 * The backend looks segments up by the first characters of the video id's
 * SHA-256, so this answers every prefix with the same two videos: the one
 * the e2e suite plays (with a sponsor segment right after the start) and an
 * unrelated one that shares the prefix, as a real hash-prefix response would.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.SPONSORBLOCK_STUB_PORT ?? 8300);

/** Eleven characters, like a real YouTube id; used by e2e/sponsorblock.spec.ts. */
export const E2E_VIDEO_ID = 'e2esponsor1';

const RESPONSE = [
  {
    videoID: 'unrelated00',
    segments: [{ segment: [0, 60], category: 'sponsor', actionType: 'skip', UUID: 'other', videoDuration: 600, locked: 0, votes: 1, description: '' }],
  },
  {
    videoID: E2E_VIDEO_ID,
    segments: [
      { segment: [1, 3], category: 'sponsor', actionType: 'skip', UUID: 'e2e-sponsor', videoDuration: 6, locked: 0, votes: 5, description: '' },
      { segment: [4, 5.5], category: 'intro', actionType: 'skip', UUID: 'e2e-intro', videoDuration: 6, locked: 0, votes: 2, description: '' },
    ],
  },
];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (url.pathname.startsWith('/api/skipSegments/')) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(RESPONSE));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, 'localhost', () => {
  console.log(`[sponsorblock-stub] listening on http://localhost:${PORT}`);
});
