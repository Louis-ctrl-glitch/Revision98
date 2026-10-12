# Revision Quest 98 — Cloudflare + GitHub deployment

This project keeps the existing Revision Quest 98 GCSE revision UI and adds a real online service:

- **Cloudflare Workers** serves `public/index.html` and handles same-origin API requests.
- **D1** stores accounts, password hashes, sessions, progress, friend requests and room metadata.
- **Durable Objects + WebSockets** coordinate live rooms, player presence, questions and host-scored rounds.
- **GitHub Actions** can deploy the Worker when changes are pushed to `main`.

The frontend still stores a local copy of the user's revision bank/progress so practice can continue while offline. Once signed into a cloud account, XP, question totals, streak, profile and friend links are synchronized with the account. The friend list is now server-backed rather than a local-only snapshot.

## Before you deploy

You need a Cloudflare account and a GitHub repository. I cannot create resources inside your accounts from this generated project; the setup below creates them in your account.

**Important:** do not deploy the placeholder D1 ID unchanged. The first Cloudflare setup step replaces it with your real database ID.

**Plan / cost note:** this configuration sets a 30,000 ms Worker CPU limit for secure password hashing. Cloudflare Free Workers are limited to 10 ms CPU per invocation, while the Standard/Workers Paid plan starts at **US$5/month** and supports a 30-second default CPU limit. Use Workers Paid for this configuration; usage can increase the bill. Verify current limits and pricing in the [official Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [pricing](https://developers.cloudflare.com/workers/platform/pricing/) docs.

## Option A — quickest setup from your computer

1. Create a new GitHub repository named `revision-quest-98` and upload all files from this project (keep the `src`, `public`, `migrations`, `.github`, `package.json`, and `wrangler.toml` structure intact).
2. Install Node.js 22.5 or later (the project uses the modern Workers toolchain). In the repository folder, run:

   ```bash
   npm install
   npx wrangler login
   npx wrangler d1 create revision-quest-db
   ```

3. Wrangler prints the D1 database UUID. Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with that UUID.
4. Apply the schema to the remote D1 database:

   ```bash
   npx wrangler d1 migrations apply revision-quest-db --remote
   ```

5. Run the source and API smoke tests, then deploy the site, API and Durable Object:

   ```bash
   npm test
   npx wrangler deploy
   ```

6. Open the `workers.dev` URL printed by Wrangler. The **Cloud account** panel should say that Cloudflare is connected. Create an account on that hosted URL; then use Friends & multiplayer to send requests, accept friends, create a room and invite them by code.

## Option B — auto-deploy from GitHub

Do the D1 creation and first remote migration from Option A once. Then add these two GitHub repository Actions secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with permission to deploy Workers and manage the Worker configuration. Grant only the minimum permissions needed for Workers Scripts, D1 and Durable Objects.
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID.

Push to the `main` branch, or run **Actions → Deploy Revision Quest 98 to Cloudflare Workers → Run workflow**. The workflow uses `wrangler.toml`, so make sure the D1 UUID has been committed first. Database migrations are deliberately a manual one-time step, not automatically applied on every deployment.

## Local development

Run `npm test` before committing changes. The smoke test uses Node’s built-in SQLite with a D1-compatible adapter; it does not touch your Cloudflare account or simulate a real WebSocket network handshake.

After replacing the D1 UUID, run:

```bash
npm install
npx wrangler d1 migrations apply revision-quest-db --local
npm run dev
```

Wrangler runs a local Worker and local D1 database. Visit the local URL it prints. Local development data is separate from the production D1 database.

## Online behavior

- **Registration/sign-in:** username + password, salted PBKDF2-SHA-256 hashes, opaque random session token stored only as a hash, `HttpOnly` / `SameSite=Lax` cookie, 30-day expiry.
- **Friends:** send requests by exact username, accept/decline requests, remove friends, see current profile stats and recently-active signals from D1.
- **Live rooms:** signed-in users create a short six-character code. A per-room Durable Object coordinates up to eight WebSocket players, lobby events, question updates, answers and scores. Guests cannot send official question/result/scoreboard/end messages; the host is authoritative for round content and scoring.
- **Progress:** XP, answered/correct counts, streak and focus subject synchronize from the current browser when it saves progress.

## Current limitations you should know about

- The room host's browser currently chooses questions and calculates scores. The Durable Object blocks guest score/result broadcasts, but this is **not an anti-cheat or ranked tournament system**. For tamper-resistant rankings, move question selection and scoring into the Durable Object itself.
- There is no password-reset or account-email verification flow yet. Keep credentials safe; adding verified email or a trusted identity provider is recommended before inviting a large public audience.
- Add Cloudflare rate limits/WAF rules for `/api/auth/login` and `/api/auth/register` before a public launch, plus a privacy notice, moderation/reporting and an account-deletion flow. These matter especially for a GCSE audience that can include children.
- The app deliberately does not upload the local profile's age or gender. The public friend profile shares username, display name, avatar, year/exam-board preferences and study stats.
- The practice bank in the existing front end is a starter revision bank, not a fully verified bank for every exam board. Check content and rights before marketing it as a complete GCSE resource.
- This bundle has been syntax-checked and its database migration validated locally, but a real Cloudflare deployment and two-device online game cannot be verified from this workspace. After deploying, test account creation, a friend request from a second account, and a game from two separate browsers/devices.

## File map

```text
public/index.html             Existing Revision Quest 98 frontend + Cloudflare integration
src/worker.js                 API, account sessions, friends, room routing and GameRoom Durable Object
migrations/0001_initial.sql   D1 schema migration
wrangler.toml                 Workers static assets, D1 and Durable Object bindings
.github/workflows/deploy.yml  GitHub Actions deployment workflow
package.json                  Wrangler scripts and dev dependency
```
