# Crazy Larry's Dumpsters — Design System Reference

Source: Claude Design export, `Crazy_Larry_s_Dumpsters_Platform.zip` (client-approved).
This doc is derived directly from the shipped `cl-tokens.css` file — treat the token values
below as authoritative; they are copied verbatim from the real stylesheet, not estimated.

---

## File Guide — What's in the Export, and How to Use Each Kind

The export contains two different formats. **Know the difference before pointing Claude Code
at any of these files:**

### A. Fully static, safe to read directly
- `Crazy Larrys Platform - Round 1.html` — Admin: Foundations, Overview, Fleet Status Board
- `Crazy Larrys Customer Portal - Round 2.html` — Customer: Size, Dates, Details, Review & Pay
- `Crazy Larry's Platform-standalone-src.dc.html` — standalone flattened version of the above
- `Crazy Larry's Customer Portal-standalone-src.dc.html` — same, customer side

These render completely with no build step. **Use these as the primary visual/layout reference.**

### B. Claude Design's internal editable format — reference only, do not copy-paste as-is
- `AdminOverview.dc.html`, `AdminScreens.dc.html`, `FleetBoard.dc.html`, `DriverApp.dc.html`,
  `CustomerAccount.dc.html`, `CustomerPortal.dc.html`, `Crazy Larry's Admin Tools.dc.html`,
  `Crazy Larry's Driver App.dc.html`, `Crazy Larry's Platform.dc.html`
- These use template placeholders (`{{ theme }}`, `{{ device }}`, `{{ j.badgeBg }}`, etc.) filled
  in at runtime by Claude Design's own preview engine (`support.js`, `doc-page.js` —
  "dc-runtime"). **They will not render correctly outside Claude Design.**
- Still valuable: view source on these for the exact inline styles, `data-cl*` attribute
  patterns, SVG icon markup, and component structure — just don't drop them into the Next.js
  app verbatim.

### C. Design tokens — the real source of truth
- `cl-tokens.css` — the actual CSS custom properties used across every screen. **This is what
  Claude Code should treat as canonical for every color, spacing, and responsive value.**

### D. Supporting assets
- `assets/logo.png` — the brand mark used in the nav
- `uploads/` — the three original reference images (Shift dashboard, CoreUI light/dark, brand logo)
- `_ds/modernist-.../` — a **generic boilerplate design system bundle** included by the Claude
  Design tool itself. Its readme describes a red/mono, zero-radius aesthetic — this is NOT
  Crazy Larry's brand. Ignore its color guidance; the structural conventions it documents
  (zero border-radius, strong 2px rules, flush-left button labels, Archivo type) do carry over
  and match what's actually built, but every color reference in that readme is boilerplate,
  not brand.

**Recommended repo placement:** commit the full export as-is to `/design-reference/`, preserving
this folder structure, so Claude Code always has both the static references (A) and the token
source of truth (C) available.

---

## Design Philosophy

The brand (logo: bold, retro-graffiti, pink/purple/teal/orange) is **rationed onto a neutral
chassis** — not wallpapered across the UI. Each brand color has exactly one job:

- **Pink** marks where you are (active nav, key figures, brand moments)
- **Teal** drives every primary action (the only color a button asks you to press)
- **Orange** ever only means *something needs you* (alerts, overdue, needs action)
- **Purple** marks Reserved status specifically
- **Dark chassis** is the neutral base — the large majority of the pixels

Zero border-radius everywhere. Strong 2px rules do the organizing instead of shadows or
rounded cards. Tabular numerals for all data — can IDs, times, and dollar amounts align in columns.

---

## Color Tokens (verbatim from `cl-tokens.css`)

### Brand scale (same in light and dark)
```css
--pink: #e91e8c;    --pink-700: #b3126a;    --pink-100: #fde4f1;
--teal: #14b5a8;    --teal-700: #0b7d74;    --teal-100: #d6f5f2;
--orange: #ff6b1a;  --orange-700: #a83d00;  --orange-100: #ffe8d9;
--purple: #8b4fd0;  --purple-700: #5c2e91;  --purple-100: #ece0fa;
--gray-st: #7d8592;
```

### Light theme (`[data-cl-theme="light"]`)
```css
--bg: #f4f4f5;         --surface: #ffffff;     --surface-2: #fafafb;
--ink: #14161a;        --ink-2: #5c636e;       --ink-3: #949aa4;
--line: #e4e6ea;       --line-strong: #14161a; --tint: #f0f1f3;
--rail-bg: #14161a;    --map-bg: #14161a;
--pink-tint-ink: #b3126a;   --pink-tint: #fde4f1;
--teal-tint-ink: #0b7d74;   --teal-tint: #d6f5f2;
--purple-tint-ink: #5c2e91; --purple-tint: #ece0fa;
--orange-tint-ink: #a83d00; --orange-tint: #ffe8d9;
```

### Dark theme (`[data-cl-theme="dark"]`)
```css
--bg: #0e1116;         --surface: #171b22;     --surface-2: #1d222a;
--ink: #f2f3f5;        --ink-2: #98a0ac;       --ink-3: #6b7280;
--line: #262c35;       --line-strong: #3d4550; --tint: #21262f;
--rail-bg: #090c10;    --map-bg: #090c10;
--pink-tint-ink: #ff8dc7;   --pink-tint: #2c1020;
--teal-tint-ink: #58e0d4;   --teal-tint: #0a2320;
--purple-tint-ink: #c39bf0; --purple-tint: #1d1430;
--orange-tint-ink: #ffb083; --orange-tint: #2e1608;
```

Dark mode is not a straight inversion — background drops to near-black (`#0e1116`), surfaces
lift slightly (`#171b22`), and the brand colors stay at full strength since they already read
clearly against a dark ground. Tinted fills swap to deep ~10% mixes so their label text stays light.

---

## Status Coding — Same 5 Colors, Every Screen, Forever

| Status | Token | Meaning |
|---|---|---|
| **Available** | `--teal` | In the yard, clean, bookable |
| **Reserved** | `--purple` | Sold, still in the yard |
| **Deployed** | `--pink` | On a site, inside its window |
| **Overdue** | `--orange` | Past pickup, accruing day rate |
| **Out of Service** | `--gray-st` | In the shop, not bookable |

---

## Responsive & Theme System — How It Actually Works

Every screen is built as **one HTML file that adapts via data attributes**, not separate
mobile/desktop files:

```html
<div data-cl="1" data-cl-theme="light|dark" data-cl-dev="desktop|mobile">
```

Layout values then swap automatically via CSS custom properties scoped to `[data-cl-dev]`:

```css
[data-cl-dev="desktop"] {
  --rail-w: 236px; --pad: 28px; --gap: 18px;
  --stat-cols: repeat(4, 1fr); --fleet-cols: repeat(6, 1fr);
  --sb: flex; --bb: none; --tools: flex;
  --h1: 30px; --hero: 44px;
}
[data-cl-dev="mobile"] {
  --rail-w: 0px; --pad: 14px; --gap: 12px; --safe-top: 58px;
  --stat-cols: repeat(2, 1fr); --fleet-cols: repeat(3, 1fr);
  --sb: none; --bb: flex; --tools: none;
  --h1: 21px; --hero: 30px;
}
```

`--sb` / `--bb` / `--tools` toggle sidebar, bottom-bar, and toolbar visibility between
desktop and mobile.

**Replicate this intent in the real Next.js build** — one component, responsive by swapping a
small set of layout tokens, rather than maintaining separate desktop/mobile component trees.
Use Tailwind responsive variants (`md:`, `lg:`) mapped to these same values.

---

## Typography

- **Font:** Archivo, loaded via Google Fonts (`wght@400;500;600;700;800;900`)
- **Screen titles (`--h1`):** 30px desktop / 21px mobile, weight 800
- **Hero stat figures (`--hero`):** 44px desktop / 30px mobile, weight 900, tight tracking
- **Nav labels:** 13px, weight 600
- **Eyebrow/small-caps labels:** ~9–11px, weight 800, uppercase, wide letter-spacing (~0.12–0.18em)
- **Numerals:** always tabular

---

## Components — Real Patterns from the Markup

### Sidebar Navigation (admin/driver, desktop)
- Fixed width `236px`, dark background (`--rail-bg`), 2px right border in `--line-strong`
- Logo + "Crazy Larry's / Operations" wordmark at top
- Nav items: icon (17×17 SVG, stroke-width 2.1) + label, flush left, 11px/16px padding
- Active state: `data-active="1"` → pink 18% tint background + white text + inset 3px pink
  left border (`box-shadow: inset 3px 0 0 #e91e8c`)
- Badge count (e.g. "3" on Fleet): small orange square, dark text, top-right of nav item
- User footer pinned to bottom: pink initials avatar + name + role label

### Top Bar
- Search field: 2px bordered box, magnifying glass icon, placeholder text in `--ink-3`
- Notification bell: 2px bordered square button, orange count badge top-right
- Mobile: hamburger menu button replaces sidebar toggle (`--bb: flex` swaps it in)

### Buttons
- Zero border-radius, 2px borders where outlined
- Primary: solid teal fill
- Secondary/outline: 2px border in `--line`, transparent background
- Labels flush-left even in wide buttons — never centered

### Status Badges/Tags
- Small, uppercase, bold, zero radius
- Background = status tint color, text = matching `-tint-ink` deep variant for contrast

### Cards
- Zero radius, 2px border in `--line` (light) or subtle lift in `--surface` (dark)
- Hover on interactive rows (`[data-clrow]:hover`) → background shifts to `--tint`
- Hover on fleet can tiles (`[data-clcan]:hover`) → 3px inset outline in `--ink`

### Icons
- Inline SVG throughout, consistently 16–17px, stroke-based (not filled), stroke-width 2.1–2.4,
  rounded line caps

---

## Screens Included in This Export

**Admin / Operations:**
- Foundations (palette, type, components, status coding)
- Overview — today's movements, fleet status donut, map, needs-action list, 7-day ceiling
- Fleet Status Board — all 32 cans, one tile each, status breakdown, available-by-size
- Admin Tools bundle (`Crazy Larry's Admin Tools.dc.html`)
- Combined Admin Screens bundle (`AdminScreens.dc.html`)

**Customer:**
- Step 1: Pick a size (live availability per size)
- Step 2: Availability calendar (5-day rental window drawn visually)
- Step 3: Booking details (address, placement, driver notes, contact, debris type)
- Step 4: Review & pay
- Customer Account (`CustomerAccount.dc.html`) — login, booking history, request-a-change

**Driver:**
- Driver App (`DriverApp.dc.html` / `Crazy Larry's Driver App.dc.html`) — daily job list, job
  detail, route/map view

---

## Known Implementation Notes (carry these into the real build)

- **Rental agreement signing:** NOT a native in-app e-signature component. Clicking "Read & Sign"
  opens a **modal popup** with an **embedded iframe** loading the client's existing DocuSign link.
- **Payment processor:** Payment section must reflect **QuickBooks Payments** as the processor,
  not a generic/unbranded card form.

---

## Usage Notes for Claude Code

- Treat `cl-tokens.css` values as the literal source of truth for every color used anywhere
  in the app — port these into the Tailwind config as custom colors rather than re-deriving them.
- Use the Round 1 / Round 2 static HTML files (category A above) for layout and markup reference.
  Use the `.dc.html` files (category B) only for viewing source structure — they won't render
  standalone.
- Reproduce the responsive pattern (one component, values swap by breakpoint) using Tailwind's
  responsive variants, matching the same desktop/mobile values documented above.
- Every new screen ships in 4 states: desktop light, desktop dark, mobile light, mobile dark —
  consistent with every screen already delivered in this export.
- Extend existing component patterns (cards, badges, nav, buttons) for any new screen type not
  yet covered, rather than introducing new visual patterns.
