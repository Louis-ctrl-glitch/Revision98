// Local API smoke tests with Node's built-in SQLite. This verifies the Worker logic
// and migration without contacting or changing a real Cloudflare account.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { GameRoom } from '../src/worker.js';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));

class D1Statement {
  constructor(sql) { this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  first() { return db.prepare(this.sql).get(...this.values) ?? null; }
  all() { return { results: db.prepare(this.sql).all(...this.values) }; }
  run() { const result = db.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
}
const env = {
  DB: { prepare(sql) { return new D1Statement(sql); } },
  ASSETS: { fetch: async () => new Response('static asset') },
  GAME_ROOMS: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response('fake websocket') }) },
};
async function call(path, { method = 'GET', body, cookie, origin = 'https://rq.test', upgrade } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  if (upgrade) headers.set('upgrade', upgrade);
  const request = new Request(`https://rq.test${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(request, env, {});
}
function cookie(response) { return response.headers.get('set-cookie').split(';')[0]; }

// Health, registration, password login, profile and progress.
let response = await call('/api/health');
assert.equal(response.status, 200);
const registerA = await call('/api/auth/register', { method: 'POST', body: { username: 'AlphaStudy', password: 'FauxPass123!', displayName: 'Alpha' } });
assert.equal(registerA.status, 201);
const userA = (await registerA.json()).user;
assert.equal(userA.username, 'AlphaStudy');
const cookieA = cookie(registerA);
response = await call('/api/auth/register', { method: 'POST', body: { username: 'AlphaStudy', password: 'DuplicatePass123!' } });
assert.equal(response.status, 409, 'duplicate usernames must be rejected');
const loginA = await call('/api/auth/login', { method: 'POST', body: { username: 'AlphaStudy', password: 'FauxPass123!' } });
assert.equal(loginA.status, 200);
const loginCookieA = cookie(loginA);
response = await call('/api/progress', { method: 'POST', cookie: loginCookieA, body: { xp: 234, answered: 20, correct: 17, streak: 4, focusSubject: 'Biology' } });
assert.equal(response.status, 200);
assert.equal((await response.json()).user.xp, 234);
response = await call('/api/profile', { method: 'PATCH', cookie: loginCookieA, body: { displayName: 'Alpha Prime', avatar: '🦊', year: 'Year 11', board: 'AQA', goal: 20, focusSubject: 'Biology' } });
assert.equal(response.status, 200);
assert.equal((await response.json()).user.displayName, 'Alpha Prime');

// Real friend request state is stored in D1: request, accept, and friends list.
const registerB = await call('/api/auth/register', { method: 'POST', body: { username: 'BetaStudy', password: 'OtherPass123!', displayName: 'Beta' } });
assert.equal(registerB.status, 201);
const cookieB = cookie(registerB);
response = await call('/api/friends/request', { method: 'POST', cookie: loginCookieA, body: { username: 'BetaStudy' } });
assert.equal(response.status, 201);
const pending = await (await call('/api/friends/requests', { cookie: cookieB })).json();
assert.equal(pending.requests.length, 1);
response = await call('/api/friends/respond', { method: 'POST', cookie: cookieB, body: { requestId: pending.requests[0].requestId, accept: true } });
assert.equal(response.status, 200);
const friends = await (await call('/api/friends', { cookie: loginCookieA })).json();
assert.equal(friends.friends.length, 1);
assert.equal(friends.friends[0].username, 'BetaStudy');

// A room code is allocated and persisted through the API.
const roomResponse = await call('/api/rooms', { method: 'POST', cookie: loginCookieA, body: { subject: 'Biology' } });
const room = await roomResponse.json();
assert.equal(roomResponse.status, 201);
assert.match(room.code, /^[A-Z0-9]{6}$/);
assert.equal(db.prepare('SELECT subject FROM rooms WHERE code=?').get(room.code).subject, 'Biology');

// Logout revokes the session.
response = await call('/api/auth/logout', { method: 'POST', cookie: loginCookieA, body: {} });
assert.equal(response.status, 200);
response = await call('/api/profile', { cookie: loginCookieA });
assert.equal(response.status, 401);

// Test Durable Object message policy with fake sockets (not a real network handshake).
class FakeSocket {
  constructor(player) { this.player = player; this.readyState = 1; this.sent = []; }
  deserializeAttachment() { return this.player; }
  serializeAttachment(player) { this.player = player; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}
const host = new FakeSocket({ id: 'h1', userId: 'host-user', username: 'RealHost', avatar: '🦊', role: 'host' });
const guest = new FakeSocket({ id: 'g1', userId: 'guest-user', username: 'RealGuest', avatar: '🐸', role: 'guest' });
const ctx = { getWebSockets: () => [host, guest], storage: { get: async key => key === 'roomCode' ? room.code : null, put: async () => {} } };
const gameRoom = new GameRoom(ctx, env);
const packet = message => JSON.stringify({ type: 'client-message', message });
await gameRoom.webSocketMessage(guest, packet({ type: 'question', question: { q: 'spoof' } }));
assert.equal(host.sent.some(m => m.event === 'game-message' && m.message.type === 'question'), false, 'guest cannot publish the official question');
await gameRoom.webSocketMessage(guest, packet({ type: 'answer', choice: 2 }));
assert.equal(host.sent.some(m => m.event === 'game-message' && m.message.type === 'answer'), true, 'guest answer reaches the host');
await gameRoom.webSocketMessage(guest, packet({ type: 'hello', username: 'FakeHost', role: 'host', avatar: '👾' }));
const hello = host.sent.find(m => m.event === 'game-message' && m.message.type === 'hello');
assert.equal(hello.message.username, 'RealGuest');
assert.equal(hello.message.role, 'guest');
await gameRoom.webSocketMessage(guest, packet({ type: 'lobby', host: 'spoofed' }));
assert.equal(host.sent.some(m => m.event === 'game-message' && m.message.type === 'lobby'), false, 'guest cannot publish official lobby state');

db.close();
console.log('PASS: Worker API smoke test — accounts, login, profile, progress, friend requests, room creation, logout, and Durable Object message policy.');
