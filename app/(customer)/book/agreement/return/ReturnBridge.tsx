"use client";

import { useEffect, useState } from "react";

const SESSION_RE = /^[0-9a-f-]{36}$/i;

export function ReturnBridge({ sessionId, event }: { sessionId: string; event: string }) {
  const [note, setNote] = useState("Returning to checkout…");

  useEffect(() => {
    if (!SESSION_RE.test(sessionId)) {
      setNote("This link isn't valid. Go back to the booking page and sign again.");
      return;
    }
    const framed = window.parent !== window;
    if (framed) {
      // Same-origin only: the wizard ignores messages from any other origin.
      window.parent.postMessage(
        { type: "cl-docusign-return", sessionId, event },
        window.location.origin,
      );
      setNote("Done. You can close this window.");
      return;
    }
    // Full-page signing (phones): go back to the wizard, which restores the
    // saved draft and asks the server to verify.
    const qs = new URLSearchParams({ agreement: sessionId, event });
    window.location.replace(`/book?${qs.toString()}`);
  }, [sessionId, event]);

  return <p>{note}</p>;
}
