/**
 * Every piece of customer- and driver-facing notification copy, in one place.
 * One function per notification_type. Each returns SMS text and an email
 * {subject,text,html}. No templating engine — tagged template literals, so
 * TypeScript checks each template only touches data the caller actually has.
 *
 * Escaping (Plan B.2): every string here is built with the html`` or text``
 * tag from ./escape, so every interpolated value is cleaned (and, in HTML,
 * escaped) without anyone deciding a field is safe. templates.scan.test.ts
 * fails on an untagged interpolation; templates.hostile.test.ts renders every
 * field with hostile values.
 */
import { html, href, joinHtml, multiline, text, type SafeHtml } from "./escape";

const YARD_PHONE = process.env.CL_YARD_PHONE || "the yard";

export interface Rendered {
  sms: string;
  email: { subject: string; text: string; html: string };
}

function fmtDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** An empty line: a spacer row in HTML. */
const BLANK = html``;

/** Wrap lines in a minimal, client-safe HTML email. Lines must be SafeHtml. */
function renderEmail(heading: SafeHtml, lines: SafeHtml[]): string {
  const body = joinHtml(
    lines.map((l) =>
      l.value === ""
        ? html`<tr><td style="height:12px"></td></tr>`
        : html`<tr><td style="padding:2px 0;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">${l}</td></tr>`,
    ),
  );
  return html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;padding:24px">
<tr><td style="font:800 18px/1.2 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e5006d;padding-bottom:12px">Crazy Larry's Dumpsters</td></tr>
<tr><td style="font:700 16px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;padding-bottom:8px">${heading}</td></tr>
${body}
<tr><td style="height:16px"></td></tr>
<tr><td style="font:12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#8a8a8a">Questions? Call ${YARD_PHONE}.</td></tr>
</table>`.value;
}

// --- customer events -------------------------------------------------------

export interface BookingCtx {
  contactName: string;
  size: string; // "20yd"
  deliveryDate: string; // yyyy-mm-dd
  pickupDate: string; // yyyy-mm-dd
  address: string;
  total: number;
  /** false for a staff-entered booking still awaiting cash/check/invoice payment. */
  paid: boolean;
}

export function bookingConfirmation(c: BookingCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  const amountLine = c.paid ? text`Paid ${money(c.total)}.` : text`Amount due ${money(c.total)}.`;
  return {
    sms: text`Crazy Larry's: booking confirmed. ${size} dumpster to ${c.address} on ${fmtDate(c.deliveryDate)}, pickup ${fmtDate(c.pickupDate)}. ${amountLine} Questions? Call ${YARD_PHONE}.`,
    email: {
      subject: text`Your dumpster is booked — ${fmtDate(c.deliveryDate)}`,
      text: [
        text`Hi ${c.contactName},`,
        ``,
        text`Your ${size} dumpster rental is confirmed.`,
        text`Delivery: ${fmtDate(c.deliveryDate)}`,
        text`Pickup:   ${fmtDate(c.pickupDate)}`,
        text`Address:  ${c.address}`,
        c.paid ? text`Paid:     ${money(c.total)}` : text`Due:      ${money(c.total)}`,
        ...(c.paid
          ? []
          : [``, `Payment isn't collected yet — we'll send you an invoice, or you can pay the yard by cash or check.`]),
        ``,
        `We'll text you the morning before delivery and again before pickup.`,
      ].join("\n"),
      html: renderEmail(html`Your dumpster is booked`, [
        html`Hi ${c.contactName},`,
        html`Your <strong>${size}</strong> dumpster rental is confirmed.`,
        BLANK,
        html`<strong>Delivery:</strong> ${fmtDate(c.deliveryDate)}`,
        html`<strong>Pickup:</strong> ${fmtDate(c.pickupDate)}`,
        html`<strong>Address:</strong> ${c.address}`,
        c.paid
          ? html`<strong>Paid:</strong> ${money(c.total)}`
          : html`<strong>Due:</strong> ${money(c.total)}`,
        ...(c.paid
          ? []
          : [BLANK, html`Payment isn't collected yet — we'll send you an invoice, or you can pay the yard by cash or check.`]),
        BLANK,
        html`We'll text you the day before delivery and again before pickup.`,
      ]),
    },
  };
}

export function deliveryReminder(c: BookingCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: text`Crazy Larry's: your ${size} dumpster arrives tomorrow (${fmtDate(c.deliveryDate)}) at ${c.address}. Please keep the drop spot clear. Call ${YARD_PHONE} with changes.`,
    email: {
      subject: text`Dumpster delivery tomorrow — ${fmtDate(c.deliveryDate)}`,
      text: [
        text`Hi ${c.contactName},`,
        ``,
        text`Reminder: your ${size} dumpster is scheduled for delivery tomorrow, ${fmtDate(c.deliveryDate)}, at ${c.address}.`,
        ``,
        `Please make sure the drop spot is clear and accessible for the truck.`,
        text`Need to reschedule? Call ${YARD_PHONE}.`,
      ].join("\n"),
      html: renderEmail(html`Delivery tomorrow`, [
        html`Hi ${c.contactName},`,
        html`Your <strong>${size}</strong> dumpster is scheduled for delivery <strong>tomorrow, ${fmtDate(c.deliveryDate)}</strong>, at ${c.address}.`,
        BLANK,
        html`Please make sure the drop spot is clear and accessible for the truck.`,
        html`Need to reschedule? Call ${YARD_PHONE}.`,
      ]),
    },
  };
}

export function pickupReminder(c: BookingCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: text`Crazy Larry's: pickup for your ${size} dumpster is tomorrow (${fmtDate(c.pickupDate)}). Please make sure it's accessible and not overloaded. Call ${YARD_PHONE} if you need another day.`,
    email: {
      subject: text`Dumpster pickup tomorrow — ${fmtDate(c.pickupDate)}`,
      text: [
        text`Hi ${c.contactName},`,
        ``,
        text`Reminder: we're scheduled to pick up your ${size} dumpster tomorrow, ${fmtDate(c.pickupDate)}, from ${c.address}.`,
        ``,
        `Please make sure it's clear for the truck and loaded no higher than the top rail.`,
        text`Need more time? Call ${YARD_PHONE} — extra days are billed at the daily rate.`,
      ].join("\n"),
      html: renderEmail(html`Pickup tomorrow`, [
        html`Hi ${c.contactName},`,
        html`We're scheduled to pick up your <strong>${size}</strong> dumpster <strong>tomorrow, ${fmtDate(c.pickupDate)}</strong>, from ${c.address}.`,
        BLANK,
        html`Please make sure it's clear for the truck and loaded no higher than the top rail.`,
        html`Need more time? Call ${YARD_PHONE}.`,
      ]),
    },
  };
}

export function deliveryComplete(c: {
  contactName: string;
  size: string;
  address: string;
  pickupDate: string;
}): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: text`Crazy Larry's: your ${size} dumpster has been delivered to ${c.address}. Scheduled pickup is ${fmtDate(c.pickupDate)}. Call ${YARD_PHONE} if anything's off.`,
    email: {
      subject: `Delivered — your dumpster is on site`,
      text: [
        text`Hi ${c.contactName},`,
        ``,
        text`Your ${size} dumpster has been dropped at ${c.address}.`,
        text`Scheduled pickup: ${fmtDate(c.pickupDate)}.`,
        ``,
        text`If the placement isn't right, call ${YARD_PHONE} today.`,
      ].join("\n"),
      html: renderEmail(html`Your dumpster is on site`, [
        html`Hi ${c.contactName},`,
        html`Your <strong>${size}</strong> dumpster has been dropped at ${c.address}.`,
        html`<strong>Scheduled pickup:</strong> ${fmtDate(c.pickupDate)}`,
        BLANK,
        html`If the placement isn't right, call ${YARD_PHONE} today.`,
      ]),
    },
  };
}

export function pickupComplete(c: {
  contactName: string;
  size: string;
  address: string;
}): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: text`Crazy Larry's: we've picked up the ${size} dumpster from ${c.address}. Thanks for renting with us! Final weight/overage charges, if any, will follow.`,
    email: {
      subject: `Picked up — thanks for renting with Crazy Larry's`,
      text: [
        text`Hi ${c.contactName},`,
        ``,
        text`We've hauled off the ${size} dumpster from ${c.address}.`,
        ``,
        `If the load was over the included weight, a separate overage charge will follow. Otherwise you're all set.`,
        ``,
        `Thanks for the business.`,
      ].join("\n"),
      html: renderEmail(html`Picked up — thanks!`, [
        html`Hi ${c.contactName},`,
        html`We've hauled off the <strong>${size}</strong> dumpster from ${c.address}.`,
        BLANK,
        html`If the load was over the included weight, a separate overage charge will follow. Otherwise you're all set.`,
        BLANK,
        html`Thanks for the business.`,
      ]),
    },
  };
}

export function overdueNotice(c: BookingCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: text`Crazy Larry's: the ${size} dumpster at ${c.address} is past its pickup date (${fmtDate(c.pickupDate)}). Daily rental charges are now accruing. Call ${YARD_PHONE} to schedule pickup.`,
    email: {
      subject: `Action needed: dumpster past pickup date`,
      text: [
        text`Hi ${c.contactName},`,
        ``,
        text`Our records show the ${size} dumpster at ${c.address} is still on site past its scheduled pickup of ${fmtDate(c.pickupDate)}.`,
        ``,
        text`Daily rental charges apply until it's picked up. Call ${YARD_PHONE} to get on the schedule.`,
      ].join("\n"),
      html: renderEmail(html`Dumpster past pickup date`, [
        html`Hi ${c.contactName},`,
        html`The <strong>${size}</strong> dumpster at ${c.address} is still on site past its scheduled pickup of <strong>${fmtDate(c.pickupDate)}</strong>.`,
        BLANK,
        html`Daily rental charges apply until it's picked up. Call ${YARD_PHONE} to get on the schedule.`,
      ]),
    },
  };
}

// --- driver event --------------------------------------------------------

export function jobAssigned(c: {
  driverName: string;
  jobType: "delivery" | "pickup";
  size: string;
  address: string;
  scheduledDate: string;
  /** Multi-line on purpose (a textarea on /book): its line breaks are kept. */
  placementNotes: string | null;
}): Rendered {
  const size = c.size.replace("yd", " yd");
  const verb = c.jobType === "delivery" ? "Drop" : "Pickup";
  return {
    sms: [
      text`Crazy Larry's dispatch: ${verb} — ${size} @ ${c.address}, ${fmtDate(c.scheduledDate)}.`,
      c.placementNotes ? text` Notes: ${multiline(c.placementNotes)}` : "",
      ` Open the driver app for the route.`,
    ].join(""),
    email: {
      subject: text`New ${c.jobType} assigned — ${fmtDate(c.scheduledDate)}`,
      text: [
        text`${c.driverName},`,
        ``,
        text`You've been assigned a ${c.jobType}:`,
        text`${size} dumpster`,
        text`${c.address}`,
        text`${fmtDate(c.scheduledDate)}`,
        c.placementNotes ? text`Notes: ${multiline(c.placementNotes)}` : "",
        ``,
        `Full route is in the driver app.`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
      html: renderEmail(html`New ${c.jobType} assigned`, [
        html`${c.driverName}, you've been assigned a ${c.jobType}:`,
        html`<strong>${size} dumpster</strong>`,
        html`${c.address}`,
        html`${fmtDate(c.scheduledDate)}`,
        c.placementNotes ? html`Notes: ${multiline(c.placementNotes)}` : BLANK,
        BLANK,
        html`Full route is in the driver app.`,
      ]),
    },
  };
}

// --- pay links -------------------------------------------------------------

/** A link button. A URL href() refuses (not absolute http/https) shows the label without a link. */
function button(url: string, label: SafeHtml): SafeHtml {
  const target = href(url);
  if (!target) return label;
  return html`<a href="${target}" style="display:inline-block;background:#0f766e;color:#ffffff;font-weight:800;text-decoration:none;padding:10px 16px">${label}</a>`;
}

export interface PayLinkCtx extends BookingCtx {
  /** The full /pay/<token> URL. Never logged: notify.ts redacts it. */
  url: string;
}

export function payLink(c: PayLinkCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: text`Crazy Larry's: your ${size} dumpster for ${fmtDate(c.deliveryDate)} is reserved. Total ${money(c.total)}. Review the agreement and pay here: ${c.url} Questions? Call ${YARD_PHONE}. Reply STOP to opt out.`,
    email: {
      subject: text`Pay for your dumpster — delivery ${fmtDate(c.deliveryDate)}`,
      text: [
        text`Hi ${c.contactName},`,
        ``,
        text`Your ${size} dumpster is reserved.`,
        text`Delivery: ${fmtDate(c.deliveryDate)}`,
        text`Pickup:   ${fmtDate(c.pickupDate)}`,
        text`Address:  ${c.address}`,
        text`Total:    ${money(c.total)}`,
        ``,
        `Review the rental agreement and pay by card here:`,
        text`${c.url}`,
        ``,
        `No cash or check needed. This link works until the booking is paid or cancelled.`,
      ].join("\n"),
      html: renderEmail(html`Pay for your dumpster`, [
        html`Hi ${c.contactName},`,
        html`Your <strong>${size}</strong> dumpster is reserved.`,
        BLANK,
        html`<strong>Delivery:</strong> ${fmtDate(c.deliveryDate)}`,
        html`<strong>Pickup:</strong> ${fmtDate(c.pickupDate)}`,
        html`<strong>Address:</strong> ${c.address}`,
        html`<strong>Total:</strong> ${money(c.total)}`,
        BLANK,
        button(c.url, html`Review &amp; pay`),
        BLANK,
        html`No cash or check needed. This link works until the booking is paid or cancelled.`,
      ]),
    },
  };
}

export function payLinkReminder(c: PayLinkCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: text`Crazy Larry's reminder: your ${size} dumpster for ${fmtDate(c.deliveryDate)} isn't paid yet (${money(c.total)}). Pay here: ${c.url} Questions? Call ${YARD_PHONE}. Reply STOP to opt out.`,
    email: {
      subject: text`Reminder: your dumpster for ${fmtDate(c.deliveryDate)} isn't paid yet`,
      text: [
        text`Hi ${c.contactName},`,
        ``,
        text`Your ${size} dumpster for ${fmtDate(c.deliveryDate)} at ${c.address} isn't paid yet (${money(c.total)}).`,
        ``,
        `Pay by card here:`,
        text`${c.url}`,
        ``,
        text`Questions or changes? Call ${YARD_PHONE}.`,
      ].join("\n"),
      html: renderEmail(html`Your dumpster isn't paid yet`, [
        html`Hi ${c.contactName},`,
        html`Your <strong>${size}</strong> dumpster for <strong>${fmtDate(c.deliveryDate)}</strong> at ${c.address} isn't paid yet (${money(c.total)}).`,
        BLANK,
        button(c.url, html`Pay now`),
        BLANK,
        html`Questions or changes? Call ${YARD_PHONE}.`,
      ]),
    },
  };
}

/** Email only, to staff. bookingUrl is the staff booking page, where Cancel lives. */
export function staffUnpaidAlert(c: {
  contactName: string;
  phone: string | null;
  size: string;
  deliveryDate: string;
  total: number;
  daysUnpaid: number;
  remindersSent: number;
  bookingUrl: string;
  reason: "after_days" | "reminder_sent";
}): Rendered {
  const size = c.size.replace("yd", " yd");
  const why =
    c.reason === "reminder_sent"
      ? text`A payment reminder was just sent (${c.remindersSent} so far).`
      : text`It has been unpaid for ${c.daysUnpaid} days (${c.remindersSent} reminder${c.remindersSent === 1 ? "" : "s"} sent).`;
  const subject = text`Unpaid booking: ${c.contactName} — delivery ${fmtDate(c.deliveryDate)} (${c.daysUnpaid} days)`;
  return {
    sms: text`${subject}. ${c.bookingUrl}`,
    email: {
      subject,
      text: [
        c.phone ? text`${c.contactName} · ${c.phone}` : text`${c.contactName}`,
        text`${size} dumpster, delivery ${fmtDate(c.deliveryDate)}, total ${money(c.total)}`,
        ``,
        why,
        `The unit stays held until the booking is paid or cancelled.`,
        ``,
        `Open the booking (call the customer, resend the link, or cancel it there):`,
        text`${c.bookingUrl}`,
      ].join("\n"),
      html: renderEmail(html`Unpaid booking`, [
        c.phone ? html`<strong>${c.contactName}</strong> · ${c.phone}` : html`<strong>${c.contactName}</strong>`,
        html`${size} dumpster, delivery <strong>${fmtDate(c.deliveryDate)}</strong>, total ${money(c.total)}`,
        BLANK,
        html`${why}`,
        html`The unit stays held until the booking is paid or cancelled.`,
        BLANK,
        button(c.bookingUrl, html`Open booking`),
        html`Call the customer, resend the link, or cancel it from the booking page.`,
      ]),
    },
  };
}
