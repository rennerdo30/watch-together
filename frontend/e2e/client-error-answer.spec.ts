import { test, expect } from '@playwright/test';
import { describeHttpAnswer } from '../lib/client-errors';

// A player reported "HTTP 403" for requests our server never saw. The
// report now says who answered, without carrying URLs, cookies or bodies.

test('a Cloudflare challenge is told apart from our own refusal', () => {
  const challenge = describeHttpAnswer([
    'https://w2g.example/api/proxy?url=x', 403,
    '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>token=SECRET</body></html>',
    { server: 'cloudflare', 'cf-ray': '8f1e2d3c4b5a6978-FRA', 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
    1,
  ]);
  expect(challenge).toBe('origin=NOT-REACHED server=cloudflare cf-ray=8f1e2d3c4b5a6978-FRA cf-mitigated=challenge '
    + 'content-type=text/html request=segment body="Just a moment..."');
  expect(challenge).not.toContain('SECRET');
  expect(challenge).not.toContain('api/proxy');

  const ours = describeHttpAnswer([
    'https://w2g.example/api/proxy?url=x', 403,
    '{"detail":"Whole-file media downloads are not served; players request byte ranges"}',
    { server: 'cloudflare', 'x-w2g-origin': 'nginx', 'cf-ray': 'abc-NRT' },
    1,
  ]);
  expect(ours).toContain('origin=reached');
  expect(ours).toContain('body="{\'detail\':\'Whole-file media downloads');
  expect(describeHttpAnswer(undefined)).toBeUndefined();
});
