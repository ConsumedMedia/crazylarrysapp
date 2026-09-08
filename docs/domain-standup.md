# Domain standup — `app.crazylarrysdumpsters.com`

Get the app reachable and functional on the production domain for the client
walkthrough + staff testing phase.

**Scope of this pass:** QuickBooks stays on **sandbox**. Do not change
`QUICKBOOKS_ENVIRONMENT`, `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, or
`QUICKBOOKS_REDIRECT_URI`. Flipping QBO to production is a separate deliberate
step for public launch.

Code change already made (commit on `main`): `app/layout.tsx` now sets
`metadataBase` from `NEXT_PUBLIC_SITE_URL` (falls back to the prod URL).

---

## 1. DNS + Vercel domain

1. Vercel → Project → **Settings → Domains** → add `app.crazylarrysdumpsters.com`.
2. At the DNS host for `crazylarrysdumpsters.com`, add the record Vercel shows —
   normally `CNAME  app  →  cname.vercel-dns.com`.
3. Wait for Vercel to show the domain as **Valid Configuration** (TLS issued).

---

## 2. Supabase — Auth URL configuration

Supabase dashboard → project `wbhwfnxphqnxiphnbcyq` → **Authentication → URL Configuration**:

| Field | Value |
|---|---|
| **Site URL** | `https://app.crazylarrysdumpsters.com` |
| **Redirect URLs** (allow list) | `https://app.crazylarrysdumpsters.com/**` <br> `http://localhost:3000/**` (keep for local dev) <br> `https://*.vercel.app/**` (optional — only if you test on preview deploys) |

Why: customer signup uses email confirmation (`supabase.auth.signUp`, no
`emailRedirectTo` in code). Supabase builds the confirmation link as
`{SUPABASE_URL}/auth/v1/verify?...&redirect_to={Site URL}`, so **Site URL** is
what the confirmed user lands on. The **Redirect URLs** list gates any
`redirect_to` value, so the prod origin must be on it.

No app-side `/auth/callback` route is needed — Supabase's own server handles the
verify step, then redirects to Site URL.

---

## 3. Vercel — environment variables (Production scope)

You add these manually. Everything already in `.env.local` that isn't listed as
**NEW** or **CHANGE** below should already be in Vercel from earlier — just
confirm it's present in the **Production** environment.

### NEW — add these

| Variable | Production value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://app.crazylarrysdumpsters.com` | Drives `metadataBase`. |
| `CRON_SECRET` | **exact same string as `CL_CRON_SECRET`** | Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; the cron routes check `process.env.CL_CRON_SECRET`. Both must exist and match. |

### CHANGE — different value in Production than local

| Variable | Production value | Why |
|---|---|---|
| `CL_ENABLE_DEV_STUBS` | `0` (or omit entirely) | Local is `1`. Gates `/api/quickbooks/ping` and the `quickbooks_force_expire` dev path — must be off in prod. |
| `CL_NOTIFICATIONS_ENABLED` | `0` for now | Keeps SMS/email silent during the walkthrough + staff testing. Flip to `1` at launch. |
| `CL_NOTIFICATIONS_TEST_TO` | leave **empty / unset** | Set it to your own number/email only during a deliberate notification-QA window, then clear it. |

### CONFIRM present (unchanged values)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_DOCUSIGN_URL`, `CL_CRON_SECRET`,
`CL_YARD_PHONE`, `QUO_API_KEY`, `QUO_FROM_NUMBER`, `RESEND_API_KEY`,
`RESEND_FROM`, `NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY`,
`GOOGLE_GEOCODING_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_JS_API_KEY`,
`QUICKBOOKS_TOKEN_ENC_KEY`, `DATABASE_URL`.

### LEAVE ALONE (sandbox — do not touch this pass)

`QUICKBOOKS_ENVIRONMENT` (= `sandbox`), `QUICKBOOKS_CLIENT_ID`,
`QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REDIRECT_URI`.

> After editing Production env vars, redeploy (Vercel does this automatically on
> the next push, or use **Redeploy** on the latest deployment) so they take effect.

---

## 4. Google Cloud console — Maps API key referrers

APIs & Services → **Credentials**. For each of the two browser keys, under
**Application restrictions → Website restrictions**, add:

```
https://app.crazylarrysdumpsters.com/*
```

Keep any existing `http://localhost:3000/*` (and `https://*.vercel.app/*` if you
use preview deploys).

| Key | API restriction | Referrer entry to add |
|---|---|---|
| `NEXT_PUBLIC_GOOGLE_MAPS_JS_API_KEY` | Maps JavaScript API | `https://app.crazylarrysdumpsters.com/*` |
| `NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY` | Maps Embed API | `https://app.crazylarrysdumpsters.com/*` |
| `GOOGLE_GEOCODING_API_KEY` | Geocoding API | **none** — server-side only, no referrer restriction |

Without this, the dashboard deployed-units map and the driver route map show
their "set the key" placeholder on the live domain even though the key is set.

---

## 5. Resend — sending domain

Email only reaches your own address via `onboarding@resend.dev` until the
`RESEND_FROM` domain is verified.

1. Check the current `RESEND_FROM` value. If it's on `crazylarrysdumpsters.com`
   (or a subdomain like `send.crazylarrysdumpsters.com`), go to Resend →
   **Domains** → add that domain.
2. Add the **SPF (TXT)**, **DKIM (CNAME ×3)**, and **DMARC (TXT)** records Resend
   generates to the domain's DNS.
3. Wait for Resend to show the domain **Verified**.

(This only matters once `CL_NOTIFICATIONS_ENABLED=1`, but the DNS propagation
lead time is worth starting now.)

---

## 6. CSP — no change needed

`next.config.mjs` applies a CSP only to `/book*`. It uses `'self'` (relative,
domain-agnostic) plus fixed allowlists for Intuit, `*.supabase.co`, and DocuSign.
Nothing domain-specific. Verify the booking flow + card tokenization still work
on the live domain after cutover, but no edit is required.

---

## Post-cutover smoke check

- [ ] `https://app.crazylarrysdumpsters.com` loads, TLS valid
- [ ] Staff login works; `/dashboard` renders with the deployed-units **map showing pins** (Google key referrer OK)
- [ ] Customer signup → confirmation email link lands back on the app (Supabase Site URL OK)
- [ ] `/book` wizard runs through to the sandbox card step
- [ ] `curl -H "Authorization: Bearer <CL_CRON_SECRET>" https://app.crazylarrysdumpsters.com/api/cron/daily` returns 200 JSON (not 401)
- [ ] `/api/quickbooks/ping` returns 404/disabled in prod (`CL_ENABLE_DEV_STUBS=0`)
- [ ] QuickBooks panel in `/settings` still shows the **sandbox** connection as `connected`
