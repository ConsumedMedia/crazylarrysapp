/**
 * Every piece of customer- and driver-facing notification copy, in one place.
 * One function per notification_type. Each returns SMS text and an email
 * {subject,text,html}. No templating engine — plain template literals, so
 * TypeScript checks each template only touches data the caller actually has.
 */

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

/** Wrap plain lines in a minimal, client-safe HTML email. */
function renderEmail(heading: string, lines: string[]): string {
  const body = lines
    .map((l) =>
      l === ""
        ? "<tr><td style=\"height:12px\"></td></tr>"
        : `<tr><td style="padding:2px 0;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">${l}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;padding:24px">
<tr><td style="font:800 18px/1.2 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e5006d;padding-bottom:12px">Crazy Larry's Dumpsters</td></tr>
<tr><td style="font:700 16px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;padding-bottom:8px">${heading}</td></tr>
${body}
<tr><td style="height:16px"></td></tr>
<tr><td style="font:12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#8a8a8a">Questions? Call ${YARD_PHONE}.</td></tr>
</table>`;
}

// --- customer events -------------------------------------------------------

export interface BookingCtx {
  contactName: string;
  size: string; // "20yd"
  deliveryDate: string; // yyyy-mm-dd
  pickupDate: string; // yyyy-mm-dd
  address: string;
  total: number;
}

export function bookingConfirmation(c: BookingCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: `Crazy Larry's: booking confirmed. ${size} dumpster to ${c.address} on ${fmtDate(c.deliveryDate)}, pickup ${fmtDate(c.pickupDate)}. Paid ${money(c.total)}. Questions? Call ${YARD_PHONE}.`,
    email: {
      subject: `Your dumpster is booked — ${fmtDate(c.deliveryDate)}`,
      text: [
        `Hi ${c.contactName},`,
        ``,
        `Your ${size} dumpster rental is confirmed.`,
        `Delivery: ${fmtDate(c.deliveryDate)}`,
        `Pickup:   ${fmtDate(c.pickupDate)}`,
        `Address:  ${c.address}`,
        `Paid:     ${money(c.total)}`,
        ``,
        `We'll text you the morning before delivery and again before pickup.`,
      ].join("\n"),
      html: renderEmail("Your dumpster is booked", [
        `Hi ${c.contactName},`,
        `Your <strong>${size}</strong> dumpster rental is confirmed.`,
        ``,
        `<strong>Delivery:</strong> ${fmtDate(c.deliveryDate)}`,
        `<strong>Pickup:</strong> ${fmtDate(c.pickupDate)}`,
        `<strong>Address:</strong> ${c.address}`,
        `<strong>Paid:</strong> ${money(c.total)}`,
        ``,
        `We'll text you the day before delivery and again before pickup.`,
      ]),
    },
  };
}

export function deliveryReminder(c: BookingCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: `Crazy Larry's: your ${size} dumpster arrives tomorrow (${fmtDate(c.deliveryDate)}) at ${c.address}. Please keep the drop spot clear. Call ${YARD_PHONE} with changes.`,
    email: {
      subject: `Dumpster delivery tomorrow — ${fmtDate(c.deliveryDate)}`,
      text: [
        `Hi ${c.contactName},`,
        ``,
        `Reminder: your ${size} dumpster is scheduled for delivery tomorrow, ${fmtDate(c.deliveryDate)}, at ${c.address}.`,
        ``,
        `Please make sure the drop spot is clear and accessible for the truck.`,
        `Need to reschedule? Call ${YARD_PHONE}.`,
      ].join("\n"),
      html: renderEmail("Delivery tomorrow", [
        `Hi ${c.contactName},`,
        `Your <strong>${size}</strong> dumpster is scheduled for delivery <strong>tomorrow, ${fmtDate(c.deliveryDate)}</strong>, at ${c.address}.`,
        ``,
        `Please make sure the drop spot is clear and accessible for the truck.`,
        `Need to reschedule? Call ${YARD_PHONE}.`,
      ]),
    },
  };
}

export function pickupReminder(c: BookingCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: `Crazy Larry's: pickup for your ${size} dumpster is tomorrow (${fmtDate(c.pickupDate)}). Please make sure it's accessible and not overloaded. Call ${YARD_PHONE} if you need another day.`,
    email: {
      subject: `Dumpster pickup tomorrow — ${fmtDate(c.pickupDate)}`,
      text: [
        `Hi ${c.contactName},`,
        ``,
        `Reminder: we're scheduled to pick up your ${size} dumpster tomorrow, ${fmtDate(c.pickupDate)}, from ${c.address}.`,
        ``,
        `Please make sure it's clear for the truck and loaded no higher than the top rail.`,
        `Need more time? Call ${YARD_PHONE} — extra days are billed at the daily rate.`,
      ].join("\n"),
      html: renderEmail("Pickup tomorrow", [
        `Hi ${c.contactName},`,
        `We're scheduled to pick up your <strong>${size}</strong> dumpster <strong>tomorrow, ${fmtDate(c.pickupDate)}</strong>, from ${c.address}.`,
        ``,
        `Please make sure it's clear for the truck and loaded no higher than the top rail.`,
        `Need more time? Call ${YARD_PHONE}.`,
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
    sms: `Crazy Larry's: your ${size} dumpster has been delivered to ${c.address}. Scheduled pickup is ${fmtDate(c.pickupDate)}. Call ${YARD_PHONE} if anything's off.`,
    email: {
      subject: `Delivered — your dumpster is on site`,
      text: [
        `Hi ${c.contactName},`,
        ``,
        `Your ${size} dumpster has been dropped at ${c.address}.`,
        `Scheduled pickup: ${fmtDate(c.pickupDate)}.`,
        ``,
        `If the placement isn't right, call ${YARD_PHONE} today.`,
      ].join("\n"),
      html: renderEmail("Your dumpster is on site", [
        `Hi ${c.contactName},`,
        `Your <strong>${size}</strong> dumpster has been dropped at ${c.address}.`,
        `<strong>Scheduled pickup:</strong> ${fmtDate(c.pickupDate)}`,
        ``,
        `If the placement isn't right, call ${YARD_PHONE} today.`,
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
    sms: `Crazy Larry's: we've picked up the ${size} dumpster from ${c.address}. Thanks for renting with us! Final weight/overage charges, if any, will follow.`,
    email: {
      subject: `Picked up — thanks for renting with Crazy Larry's`,
      text: [
        `Hi ${c.contactName},`,
        ``,
        `We've hauled off the ${size} dumpster from ${c.address}.`,
        ``,
        `If the load was over the included weight, a separate overage charge will follow. Otherwise you're all set.`,
        ``,
        `Thanks for the business.`,
      ].join("\n"),
      html: renderEmail("Picked up — thanks!", [
        `Hi ${c.contactName},`,
        `We've hauled off the <strong>${size}</strong> dumpster from ${c.address}.`,
        ``,
        `If the load was over the included weight, a separate overage charge will follow. Otherwise you're all set.`,
        ``,
        `Thanks for the business.`,
      ]),
    },
  };
}

export function overdueNotice(c: BookingCtx): Rendered {
  const size = c.size.replace("yd", " yd");
  return {
    sms: `Crazy Larry's: the ${size} dumpster at ${c.address} is past its pickup date (${fmtDate(c.pickupDate)}). Daily rental charges are now accruing. Call ${YARD_PHONE} to schedule pickup.`,
    email: {
      subject: `Action needed: dumpster past pickup date`,
      text: [
        `Hi ${c.contactName},`,
        ``,
        `Our records show the ${size} dumpster at ${c.address} is still on site past its scheduled pickup of ${fmtDate(c.pickupDate)}.`,
        ``,
        `Daily rental charges apply until it's picked up. Call ${YARD_PHONE} to get on the schedule.`,
      ].join("\n"),
      html: renderEmail("Dumpster past pickup date", [
        `Hi ${c.contactName},`,
        `The <strong>${size}</strong> dumpster at ${c.address} is still on site past its scheduled pickup of <strong>${fmtDate(c.pickupDate)}</strong>.`,
        ``,
        `Daily rental charges apply until it's picked up. Call ${YARD_PHONE} to get on the schedule.`,
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
  placementNotes: string | null;
}): Rendered {
  const size = c.size.replace("yd", " yd");
  const verb = c.jobType === "delivery" ? "Drop" : "Pickup";
  return {
    sms: `Crazy Larry's dispatch: ${verb} — ${size} @ ${c.address}, ${fmtDate(c.scheduledDate)}.${c.placementNotes ? ` Notes: ${c.placementNotes}` : ""} Open the driver app for the route.`,
    email: {
      subject: `New ${c.jobType} assigned — ${fmtDate(c.scheduledDate)}`,
      text: [
        `${c.driverName},`,
        ``,
        `You've been assigned a ${c.jobType}:`,
        `${size} dumpster`,
        `${c.address}`,
        `${fmtDate(c.scheduledDate)}`,
        c.placementNotes ? `Notes: ${c.placementNotes}` : "",
        ``,
        `Full route is in the driver app.`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
      html: renderEmail(`New ${c.jobType} assigned`, [
        `${c.driverName}, you've been assigned a ${c.jobType}:`,
        `<strong>${size} dumpster</strong>`,
        `${c.address}`,
        `${fmtDate(c.scheduledDate)}`,
        c.placementNotes ? `Notes: ${c.placementNotes}` : "",
        ``,
        `Full route is in the driver app.`,
      ]),
    },
  };
}
