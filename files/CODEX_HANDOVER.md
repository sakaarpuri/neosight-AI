# Neo-Sight AI — Saaf Nazar Initiative
## Codex Handover Brief

---

## Project Overview

Satirical landing page for a fake AI glasses product ("Neo-Sight AI") that redirects visitors into signing a cleanliness awareness statement for India. Users arrive expecting a product page, instead they see the satire and are asked to "show it matters" by submitting their name, state, and optional city. A live counter and state-wise leaderboard show participation across India.

---

## Architecture

```
GitHub Repo
├── site/                    # Static site (Cloudflare Pages)
│   ├── index.html           # Main landing page (provided)
│   ├── neo-sight_glasses.png # Product image front (provided)
│   └── new_glass_angle_2.png # Product image side (provided)
├── worker/                  # Cloudflare Worker (API)
│   ├── src/
│   │   └── index.ts         # Worker logic
│   ├── wrangler.toml        # Cloudflare config
│   └── package.json
└── README.md
```

**Stack:**
- **Hosting:** Cloudflare Pages (free tier, unlimited bandwidth)
- **API:** Cloudflare Workers (free tier: 100k requests/day, $5/month for 10M)
- **Database:** Cloudflare D1 (free tier: 5GB SQLite at edge)
- **Domain:** TBD (can use .pages.dev initially)

---

## Database Schema (D1)

```sql
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  city TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_hash TEXT  -- hashed IP, not raw, for light dedup
);

CREATE INDEX idx_state ON submissions(state);
CREATE INDEX idx_created ON submissions(created_at);
```

No user accounts table needed. Sign-up for comments is a future feature — for now the "Sign up" link can be a placeholder or collect email only.

---

## API Endpoints (Cloudflare Worker)

### POST /api/submit
Accepts form submission.

**Request body:**
```json
{
  "name": "Rahul",
  "state": "Maharashtra",
  "city": "Pune"
}
```

**Validation:**
- `name` required, trimmed, max 50 chars
- `state` required, must match valid Indian state/UT list
- `city` optional, max 50 chars
- Dedup: same IP + same name + same state = reject (allows multiple people from same IP with different names)

**Response:**
```json
{
  "success": true,
  "total": 12848,
  "state_count": 2342
}
```

### GET /api/stats
Returns counter + leaderboard.

**Response:**
```json
{
  "total": 12847,
  "by_state": [
    {"state": "Maharashtra", "count": 2341},
    {"state": "Delhi", "count": 1892},
    ...
  ]
}
```

**Caching:** This endpoint should return a cached response. Cache for 60 seconds using Cloudflare Cache API or a D1 stats table that updates every 60s. This is critical — at viral scale, every page load should NOT hit D1 directly for the leaderboard.

---

## Caching Strategy

The counter and leaderboard are read-heavy. At viral scale (thousands of concurrent users), every page load would query D1 for aggregated stats — that's expensive.

**Solution:** Use a `stats_cache` table or Cloudflare KV:

Option A — D1 stats table:
```sql
CREATE TABLE stats_cache (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME
);
```
On each POST /api/submit, increment the cached total and state count directly.
GET /api/stats reads from this table (single row read, very fast).

Option B — Cloudflare KV:
Store `total_count` and `leaderboard_json` in KV.
Update on each submission. KV reads are free and globally distributed.
KV has eventual consistency (~60s) which is fine for this use case.

**Recommendation:** Option B (KV) is simpler and better for read-heavy viral traffic. Use D1 as source of truth, KV as the read cache.

---

## Frontend Integration

The provided `index.html` (landing-light.html) needs these changes:

### 1. On page load — fetch stats
```javascript
fetch('/api/stats')
  .then(r => r.json())
  .then(data => {
    document.getElementById('totalNum').textContent = data.total.toLocaleString();
    // Rebuild leaderboard rows from data.by_state
    // Update map dot sizes proportionally based on state counts
  });
```

### 2. On form submit — POST to API
Replace the current client-side-only submit logic:
```javascript
btn.addEventListener('click', async () => {
  btn.disabled = true;
  btn.textContent = '...';
  
  const res = await fetch('/api/submit', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      name: uName.value.trim(),
      state: uState.value,
      city: document.getElementById('uCity').value.trim() || null
    })
  });
  
  const data = await res.json();
  
  if (data.success) {
    // Show success state
    document.getElementById('formCard').style.display = 'none';
    document.getElementById('doneMsg').style.display = 'block';
    document.getElementById('doneState').textContent = uState.value;
    document.getElementById('totalNum').textContent = data.total.toLocaleString();
    document.getElementById('doneCount').textContent = data.total.toLocaleString();
    // Set localStorage flag to prevent re-submission from same browser
    localStorage.setItem('neosight_submitted', 'true');
  } else {
    btn.disabled = false;
    btn.textContent = 'Count me in →';
    alert(data.error || 'Something went wrong. Try again.');
  }
});
```

### 3. On page load — check if already submitted
```javascript
if (localStorage.getItem('neosight_submitted')) {
  // Hide form, show a "You've already been counted" message
  // Still show stats and leaderboard
}
```

### 4. Leaderboard should be dynamic
Currently hardcoded HTML rows. Replace with JS that builds rows from /api/stats response. Sort by count descending. Show top 15 states.

---

## Dedup Rules

| Scenario | Allowed? |
|---|---|
| Same IP, different name + state | ✅ Yes (office colleagues) |
| Same IP, same name, same state | ❌ No (duplicate) |
| Same browser, any details | ❌ No (localStorage flag) |
| Different browser, same person | Allowed — acceptable leakage |

Hash the IP before storing (SHA-256). Never store raw IPs.

---

## Valid States/UTs List (for server-side validation)

```
Andhra Pradesh, Arunachal Pradesh, Assam, Bihar, Chhattisgarh,
Goa, Gujarat, Haryana, Himachal Pradesh, Jharkhand, Karnataka,
Kerala, Madhya Pradesh, Maharashtra, Manipur, Meghalaya, Mizoram,
Nagaland, Odisha, Punjab, Rajasthan, Sikkim, Tamil Nadu, Telangana,
Tripura, Uttar Pradesh, Uttarakhand, West Bengal,
Andaman & Nicobar Islands, Chandigarh,
Dadra & Nagar Haveli and Daman & Diu, Delhi,
Jammu & Kashmir, Ladakh, Lakshadweep, Puducherry
```

---

## Deployment Steps

### 1. Create D1 database
```bash
npx wrangler d1 create neosight-db
```

### 2. Run migrations
```bash
npx wrangler d1 execute neosight-db --file=./schema.sql
```

### 3. If using KV, create namespace
```bash
npx wrangler kv:namespace create STATS_CACHE
```

### 4. Configure wrangler.toml
```toml
name = "neosight-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "neosight-db"
database_id = "<from step 1>"

[[kv_namespaces]]
binding = "STATS"
id = "<from step 3>"

[site]
bucket = "../site"
```

### 5. Deploy
```bash
npx wrangler deploy
```

### 6. Connect Cloudflare Pages
Connect GitHub repo to Cloudflare Pages. Set build output directory to `/site`. Auto-deploys on push.

### 7. Custom domain (later)
Add custom domain in Cloudflare Pages settings when ready.

---

## Seed Data

Pre-seed the database with ~12,000 submissions spread across states to make the leaderboard feel active on launch. Distribution should roughly follow:

| State | Seed Count |
|---|---|
| Maharashtra | 2,341 |
| Delhi | 1,892 |
| Uttar Pradesh | 1,654 |
| Karnataka | 1,487 |
| Tamil Nadu | 1,203 |
| West Bengal | 987 |
| Gujarat | 876 |
| Punjab | 654 |
| Kerala | 521 |
| Rajasthan | 498 |
| Bihar | 412 |
| Telangana | 322 |

Generate a seed SQL script with INSERT statements. Names can be generic Indian first names. Cities can be major cities per state.

---

## Files Provided

1. `landing-light.html` — Complete landing page (rename to index.html)
2. `neo-sight_glasses.png` — Product hero image (front angle)
3. `new_glass_angle_2.png` — Product image (side angle)

---

## Out of Scope (Future)

- Sign-up / comments system
- Email collection
- Admin dashboard for viewing submissions
- Social share preview meta tags (og:image, og:title etc) — should be added before launch
- Analytics (add Cloudflare Web Analytics — free, privacy-friendly)

---

## Key Reminders for Codex

- The site MUST load fast in India on mobile. Keep it under 500KB total.
- Cache the /api/stats response aggressively. One D1 read per minute max.
- Hash IPs, never store raw.
- The form should feel instant — optimistic UI, show success immediately.
- The counter on the page should feel alive — load real number on page load.
- Don't over-engineer. This is a one-page satirical site, not a SaaS product.
