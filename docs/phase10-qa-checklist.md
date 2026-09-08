# Phase 10 — Technical QA Checklist

Owner: Nathan. Run against the demo-seeded database (`scripts/seed-demo.mjs`).

**Legend**
- 🟢 **In-app only** — verifiable entirely in the browser / admin UI, no third-party account needed.
- 🟠 **External verification** — also requires checking QuickBooks sandbox, a real phone/inbox, or Supabase dashboard.
- Each item: `[ ]` pass / `[ ]` fail + note.

**Notification test setup (do once, before the 🟠 notification items):**
1. In `.env.local` set `CL_NOTIFICATIONS_ENABLED=1`.
2. Set `CL_NOTIFICATIONS_TEST_TO` to **your** mobile number **or** your email (one channel at a time — a number redirects SMS and skips email; an email redirects email and skips SMS).
3. Restart `next dev`.
4. **Revert `CL_NOTIFICATIONS_ENABLED=0` when finished.**

---

## A. Customer booking — happy path 🟢/🟠

| # | Step | Expect |
|---|---|---|
| A1 | `/book` — pick size, valid future date, address, contact, debris | Wizard advances; live quote matches `cl_pricing` (base + 7.5% tax) |
| A2 | Availability calendar | Today + past greyed out; earliest selectable = tomorrow ([[availability-earliest-date-tomorrow]]) |
| A3 | Sold-out size | Temporarily `update dumpsters set status='out_of_service' where size='10yd'` for all 10yd, retry a 10yd booking on a tight date → "that date just filled up" / size unavailable; **restore statuses after** |
| A4 | DocuSign step | Agreement modal opens `NEXT_PUBLIC_DOCUSIGN_URL`; booking `docusign_status` stays `pending` until staff advance it (no live callback) |
| A5 | Review & Pay — valid sandbox test card (Visa `4111 1111 1111 1111`, any future exp, any CVV) | Redirect to `/book/confirmed/[id]`; booking `status='confirmed'`, `payment_status='paid'` |
| A6 🟠 | After A5, check `invoices` row | `qb_charge_id` set, `status='paid'`, `sync_status` → `synced` (or `pending` then cleared by `/api/cron/quickbooks-sync`) |
| A7 🟠 | After A5, QuickBooks sandbox | Invoice created for the booking; **tax is a line item, not an invoice-level tax** ([[quickbooks-oauth-token-refresh]]); amount matches |
| A8 🟠 | After A5, confirmation notification | One `booking_confirmation` email **and** SMS attempt logged in `notifications_log` (`delivery_status='sent'` when enabled + routed to your test address) |

## B. Customer booking — failure paths 🟢/🟠

| # | Step | Expect |
|---|---|---|
| B1 🟠 | Declined card — use Intuit's decline test card (`4000 0000 0000 0002`) | Stay on Review & Pay; message "that payment didn't go through"; **no booking created**; `payment_attempts` row `kind='declined'` |
| B2 | Sold-out at checkout (race) — start a booking for a size/date with exactly 1 unit left, in another tab consume that unit, then pay | `code='compensated'`; message says card authorization reversed; `payment_attempts` `kind='compensating_refund'`; **no booking** |
| B3 🟠 | B2 refund side | `refund_succeeded:true` in the attempt `context`; corresponding void/refund visible in QuickBooks sandbox |
| B4 | Expired / stale session — leave Review & Pay open past token life, then submit | Graceful error, no charge, no partial booking |
| B5 | Pricing gate — `update cl_pricing set is_active=false where size='15yd'`, load `/book` | 15yd unselectable / "call the yard"; **restore after** ([[booking-pricing-gate-and-tax]]) |
| B6 | Invalid inputs — past date, empty address, bad email, rental days >60 | Field-level validation blocks submit; server rejects if forced |

## C. Availability calendar edge cases 🟢

| # | Step | Expect |
|---|---|---|
| C1 | Add a `calendar_blocks` row (size-specific) covering a date | That size shows blocked on the delivery day **and** on the day = delivery + rental − 1; middle days unaffected |
| C2 | Add a fleet-wide block (`size IS NULL`) | All three sizes blocked on that date |
| C3 | Open-ended booking (`pickup_date NULL`) | Commits that size for every future window until closed |
| C4 | Buffer day — book a unit `[Jan 1–Jan 5]`, try another on the same unit starting Jan 5 | Rejected (closed `[]` range, [[double-booking-range-bound-decision]]) |
| C5 | `returned` / `cancelled` bookings | Excluded from committed count — capacity frees up |
| C6 | `out_of_service` unit | Removed from bookable total for its size |

## D. Admin lifecycle transitions 🟢

Use booking #10 (pickup_scheduled) and #2 (confirmed) from the seed.

| # | Step | Expect |
|---|---|---|
| D1 | `confirmed → delivered → active` via booking detail controls | Each writes a `status_log` row; illegal skips (e.g. `confirmed → returned`) are not offered and rejected if forced (`23514`) |
| D2 | `active → pickup_scheduled` | A pickup job is auto-created (`scheduled_date = pickup_date`), exactly one, idempotent on re-entry |
| D3 | `→ overdue` then back to `pickup_scheduled` / `returned` | Allowed per state machine; unit status tracks correctly |
| D4 | Cancel a booking with an assigned unit + open jobs | Non-completed jobs → `cancelled`; assigned unit freed to `available`; all logged |
| D5 | `mark_overdue_bookings` (hit `/api/cron/overdue`) | Only `active`/`pickup_scheduled` with `pickup_date < today` flip to `overdue`; returns the ids |
| D6 | Manual DocuSign advance (`not_sent → pending → signed`) | `set_booking_docusign_status` updates; staff-only |

## E. Dispatch / truck-restriction enforcement 🟢

The seed wires **Marcus Webb → Pepperoni** (restricted: no roofing / heavy-construction tags, no stone/concrete debris, no Shaffer Construction / Bluefield / NoCo Exteriors), **Danielle Cortez → Kenny Powers** (15/20yd only), **Ray Sczepanski → no truck**.

| # | Step | Expect |
|---|---|---|
| E1 | **Blocked assignment** — create a booking for "Shaffer Construction" with debris "construction debris", try to assign its delivery job to **Marcus** | Assignment **blocked**; blocker lists the customer rule + `heavy_construction` job-tag rule; RPC error `hint='assignment_blocked'` |
| E2 | Same job → assign to **Danielle** | Succeeds (Kenny Powers, 20yd allowed, no restriction) |
| E3 | **Warn + override** — booking #8 (Cardinal Remodeling, "brick and masonry rubble", `stone_concrete` tag, tags unconfirmed) → assign to **Marcus** | Warning `untagged_review` (not a blocker); `requires_override=true`; assigning without override → `hint='override_required'`; with override → succeeds, `status_log` note says "(override)" |
| E4 | Capacity — assign a **10yd** job to **Danielle** (Kenny Powers = 15/20 only) | Blocked `size_not_allowed` |
| E5 | Assign any job to **Ray** (no truck) | Blocked `no_truck` |
| E6 | Assign to an **inactive** driver (toggle Ray inactive) | Blocked `driver_inactive` |
| E7 | Confirm job tags on booking #8, then re-check Marcus | `untagged_review` warning gone; assignment now clean |
| E8 | Route ordering — drag/set order for a driver's day | `set_route_order` persists `route_order`; driver app + dispatch show the same sequence |
| E9 | Unit assignment — assign a unit of the wrong size / a non-available unit | Rejected (`23514`) |

## F. Driver job completion 🟢/🟠

Log in as **Marcus** (driver app `/driver`).

| # | Step | Expect |
|---|---|---|
| F1 | Open an assigned **delivery** job | "Mark delivered" is **disabled** until a placement photo is attached |
| F2 | Attach photo → mark delivered | Job `completed`; `job_photos` row written; booking `confirmed→delivered→active`; unit `reserved→deployed` |
| F3 | 🟠 Completion SMS | `delivery_complete` SMS logged (to your test number if enabled) |
| F4 | **Pickup** job → mark picked up **without** a photo | Allowed (photo optional on pickups); booking → `returned`; unit → `available` |
| F5 | Photo upload fails (throttle network / kill the request) | Completion still succeeds; `state.photoWarning` shown; server logs the orphan path — job is **not** blocked |
| F6 | Try to complete a job not assigned to you (edit the URL to another job id) | `42501` "isn't assigned to you" |
| F7 | Driver map (`/driver/map`) | Route renders via Maps Embed; if `NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY` blank → placeholder, no crash |
| F8 | Bottom tab nav + `/driver/me` + `/driver/done` | All four tabs work; completed jobs move to Done |

## G. Notifications 🟠

With `CL_NOTIFICATIONS_ENABLED=1` and `CL_NOTIFICATIONS_TEST_TO` = your address.

| # | Step | Expect |
|---|---|---|
| G1 | Trigger each type: booking_confirmation (checkout), job_assigned (assign), delivery_complete / pickup_complete (driver), overdue_notice (`/api/cron/overdue`), delivery_reminder + pickup_reminder (`/api/cron/reminders`) | Each writes a `notifications_log` row; `delivery_status` `sent` (routed to you) / `skipped` (disabled) / `failed` (+ `failure_category`) |
| G2 | Reminder cron idempotency — hit `/api/cron/reminders` twice | Second run reports `skipped` for the same bookings (48h `alreadyNotified` guard) |
| G3 | `notification_health()` — surfaced on `/dashboard` banner | `ok` when a real send succeeded in 24h; `blocked` only when `account_blocked` / `not_configured` with zero sends; silent otherwise |
| G4 | Disabled path — set `CL_NOTIFICATIONS_ENABLED=0`, trigger a booking | Row logged `delivery_status='skipped'`, `failure_category='disabled'`; **no send**; booking still completes |
| G5 | Never-throws contract — set a bogus `QUO_API_KEY`, trigger | Operation completes; failure logged with category, no exception bubbles to the user |

## H. Customer portal + request-change flow 🟢

Log in at `/account/login` as **rebecca.lund@example.com** (password printed by the seed).

| # | Step | Expect |
|---|---|---|
| H1 | Account home | Shows bookings #1 (confirmed), #5 (active), #12 (returned) — guest bookings linked by verified email |
| H2 | New signup with an email that matches an existing guest `customers` row | `claim_guest_bookings()` links them on first load; a signup with **no** matching bookings is a valid empty state, not an error |
| H3 | Request a change on booking #1 (new delivery date) | Shows live availability + cost impact for the new date; submits a `booking_change_requests` row `pending`; **booking itself unchanged** |
| H4 | Admin `/requests` | Pending badge count correct; request visible on the booking detail page |
| H5 | Staff approves the request | Request → `approved`; **booking still not auto-changed** — staff must make the actual edit via lifecycle controls |
| H6 | Customer withdraws a still-pending request | → `cancelled`; cannot self-approve (RLS `with check` pins to `cancelled`) |
| H7 | Customer tries to read another customer's booking (edit URL id) | RLS blocks — not found |

## I. Payments / refunds 🟠

| # | Step | Expect |
|---|---|---|
| I1 | Admin refund on a paid booking (partial + full) | `record_refund`; `invoices.status='refunded'`, `refund_kind` void/refund, `refunded_amount` set; booking `payment_status='refunded'` |
| I2 | Refund in QuickBooks sandbox | Matching refund/void object; amount reconciles |
| I3 | `cancel_and_refund` | Refund bookkeeping **and** cancellation in one transaction; if the booking is already terminal the whole thing rolls back |
| I4 | QBO token refresh — hit `/api/cron/quickbooks-refresh` (or `quickbooks_force_expire` via dev stub then any QBO call) | Token refreshes once under the `FOR UPDATE` lock; `quickbooks_connection.refresh_count` increments; concurrent callers don't double-refresh |
| I5 | Invoice sync retry — set an invoice `sync_status='error'`, run `/api/cron/quickbooks-sync` | Re-attempted; → `synced` on success |
| I6 | `/settings` QuickBooks panel | Shows `connected`, realm id, last refresh — never a token |

## J. Deployed-units map 🟢/🟠

| # | Step | Expect |
|---|---|---|
| J1 | `/dashboard` map | Pins for every **deployed** unit with a geocodable address — seed gives ~6 (#4,5,6,7,8,11); available/in-yard units are **not** pinned |
| J2 🟠 | First load geocoding | Bookings missing `delivery_lat/lng` get one Geocoding API call, cached back to the row; second load makes no new calls |
| J3 | `GOOGLE_GEOCODING_API_KEY` blank | Units still listed (on-site list), just no pins — no crash |
| J4 | `NEXT_PUBLIC_GOOGLE_MAPS_JS_API_KEY` blank | Map area shows a placeholder |
| J5 | An `overdue` booking (#11) | Appears on the map and in the dashboard "needs action" / overdue count |

## K. Light / dark mode + tablet layout 🟢

| # | Step | Expect |
|---|---|---|
| K1 | Theme toggle (all shells: admin, driver, customer, portal) | Switches instantly; choice persists across reloads; respects system default when unset |
| K2 | Dark mode — every surface | No unreadable text, no white flashes; charts/donut/map controls legible |
| K3 | Driver app at tablet width (768–1024) | Tablet layout engages; tap targets adequate; bottom nav intact |
| K4 | Motion — optimistic UI, skeletons, button-press | Skeletons on slow loads; optimistic updates reconcile; no layout jank; shared timing tokens consistent |
| K5 | Admin dashboard / dispatch at narrow width | Responsive; no horizontal body scroll |

## L. Auth / RLS boundaries 🟢

| # | Step | Expect |
|---|---|---|
| L1 | Driver hits an admin route | Redirected / 403 |
| L2 | Customer hits `/dashboard` or `/dispatch` | Blocked |
| L3 | Logged-out hits any protected route | Redirect to login |
| L4 | Owner-only bits (revenue-today card, pricing edit) | Hidden/read-only for non-owner staff |
| L5 | Direct PostgREST poke as an authenticated customer against `bookings`/`jobs`/`drivers` | Only own rows (customer) / assigned rows (driver) visible |

---

### Regression sweep before launch
- [ ] `npm test` green
- [ ] `npm run build` clean
- [ ] `CL_NOTIFICATIONS_ENABLED` back to `0` (or intended launch value) and `CL_NOTIFICATIONS_TEST_TO` cleared
- [ ] `CRON_SECRET` / `CL_CRON_SECRET` set in Vercel ([[cron-routes-need-scheduler]])
- [ ] `tax_verified` resolved for Franklin County OH ([[booking-pricing-gate-and-tax]])
- [ ] Seed-admin owner account confirmed deleted from Supabase Auth
- [ ] Real Google Maps keys restricted to their APIs + referrers
