# Crazy Larry's Dumpsters — Walkthrough Script

For the client walkthrough meeting. Plain language, no technical setup required — the demo
site is already loaded with a realistic snapshot: a few upcoming jobs, several dumpsters
out on rent right now, a couple ready for pickup, one that's run late, and some finished
rentals in the history.

Take your time on each step. If something doesn't look right or doesn't make sense, say so —
that's exactly what this meeting is for.

---

## Part 1 — Things for Larry to try

### 1. See the whole business at a glance
- Open the **Overview** page.
- You should see today's deliveries and pickups, how many dumpsters are out on rent, how
  many are overdue, and a **map of every dumpster currently on a customer's property**.
- Check: do the numbers match what you'd expect for a normal day? Is the map showing pins
  in the right parts of town?

### 2. Look at a customer's rental
- Go to **Bookings**, open any one that's "active".
- You'll see the address, the dates, the price, whether they've signed the agreement, the
  dumpster assigned to them, and the full history of that rental.
- Check: is this everything you'd want to know when a customer calls asking about their bin?

### 3. Handle a dumpster that's running late
- Find the booking marked **overdue** (there's one in the demo).
- This is the one you'd call the customer about. See how it stands out on the Overview page
  and on the map.
- Check: is "overdue" obvious enough? Would your team notice it?

### 4. Schedule a pickup
- Open a booking that's "active" and move it to **pickup scheduled**.
- Notice the system automatically creates a pickup job for your drivers — you don't have to
  add it manually.
- Check: does the pickup date it picked match how you actually schedule pickups?

### 5. Assign a job to the right truck
- Go to **Dispatch**.
- Try to assign the **Shaffer Construction** job to **Marcus / Pepperoni**.
- The system should stop you — Pepperoni isn't allowed on Shaffer jobs (or heavy
  construction, roofing, or concrete). Now assign it to **Danielle / Kenny Powers** instead.
- Check: are the truck rules it's enforcing actually your rules? Anything missing or wrong?

### 6. Override a soft warning
- In Dispatch, try assigning the **Cardinal Remodeling** job to **Marcus / Pepperoni**.
- This time you get a *warning* (the job hasn't been categorized yet), not a hard stop —
  you can review and continue if you know it's fine.
- Check: is the difference between "blocked" and "just warning me" clear?

### 7. Set the price list
- Go to **Settings** (owner only).
- This is where your real rates live. Confirm the 10 / 15 / 20 yard prices and the sales
  tax rate are correct. Online booking stays closed for any size that doesn't have a price.
- Check: are these your actual current rates?

### 8. See the money side
- On a paid booking, look at the invoice status and whether it synced to QuickBooks.
- Try issuing a **refund** on one.
- Check: does this match how you handle refunds today?

### 9. Read the customer's view
- Log in to the **customer account** (we'll give you the demo login).
- This is what your customers see: their rental history, and a button to **request a change**
  to their dates.
- Check: is this the right amount of self-service — not too much, not too little?

### 10. Switch to dark mode
- Use the light/dark toggle (top of the screen).
- Check: does the darker version look good? Some of your team may prefer it, especially
  drivers using phones outdoors.

---

## Part 2 — Things for the office staff to try

### 1. Take a booking over the phone
- Go to the **booking page** as if you were a customer.
- Book a 20-yard for a made-up address a few days out. Use the test card we provide.
- You'll go through: pick size → pick a date (note you can't pick today or the past) →
  address → sign the agreement → pay.
- Check: is this flow something you could talk a customer through on the phone? Too many
  steps? Confusing anywhere?

### 2. Try to book something that's not available
- Try to pick **today** or a **past date** — the calendar won't let you.
- Check: does it explain *why* clearly enough?

### 3. Move a rental through its life
- Take a "confirmed" booking and walk it forward: **delivered → active → pickup scheduled
  → returned**.
- Notice you can only move it to the *next* sensible step — you can't skip ahead or go
  backward into a weird state.
- Check: do these steps match the words your team actually uses?

### 4. Assign the day's work to drivers
- In **Dispatch**, take the unassigned jobs and assign them to Marcus, Danielle, or Ray.
- Put them in the order you'd actually drive them.
- Notice Ray has no truck assigned, so he can't take jobs until he's given one.
- Check: is assigning a day's routes fast enough? What would slow you down on a busy morning?

### 5. Handle a change request
- A customer (in the demo) has asked to move their pickup date.
- Find it under **Requests**, review the new date and what it would cost, and approve or
  decline it. If you approve, you still make the actual date change yourself.
- Check: is "approve the request, then make the change" the right way to do this, or should
  approving change the booking automatically?

### 6. Look up a customer
- Go to **Customers**, open one, see all their past and current rentals in one place.
- Check: when a repeat customer calls, is this what you'd want in front of you?

### 7. Check for problems
- On the **Overview** page, look at the "needs action" area — overdue rentals, unassigned
  jobs, anything stuck.
- Check: is this a good morning checklist? Anything you'd add?

---

## Part 3 — Things for the drivers to try (phone or tablet)

### 1. See today's route
- Open the **driver app** and log in as Marcus (or Danielle).
- You'll see your jobs for today, in order, with the address, dumpster size, and any
  placement notes.
- Check: is this clear at a glance from a truck?

### 2. Complete a delivery
- Open a delivery job. **Take a photo** of where you put the dumpster — you can't mark it
  done without one.
- Mark it delivered.
- Check: is requiring the photo on drops reasonable? Does the camera step work smoothly?

### 3. Complete a pickup
- Open a pickup job. Mark it picked up — no photo needed this time.
- Check: right call to make the photo optional on pickups?

### 4. Use the map
- Open the **map** tab to see the route.
- Check: is it good enough for getting around, or do you still just use your own phone maps?

### 5. Check what's done
- Open the **Done** tab to see today's completed stops.
- Check: helpful for end-of-day, or unnecessary?

---

## After the meeting

Collect answers to every "Check:" above. Anything marked wrong, missing, or confusing goes
on the punch list before go-live. Priorities:
1. Truck assignment rules — must be exactly right.
2. The words used for each rental stage — must match how the team talks.
3. Pricing and tax — must be correct.
4. Anything that would slow the office down on a busy morning.
