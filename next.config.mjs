/** @type {import('next').NextConfig} */

// Card fields on the Review & Pay page POST directly to Intuit's tokenization
// endpoint. This CSP pins where the page may open network connections so an
// injected script cannot exfiltrate card data elsewhere (PCI SAQ A-EP posture).
const BOOK_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://sandbox.api.intuit.com https://api.intuit.com https://*.supabase.co",
  "frame-src https://*.docusign.net https://*.docusign.com",
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");

// /pay/<token>: same card-page CSP, plus — because the URL itself is the
// credential — never sent as a Referer, never cached, never indexed.
const PAY_HEADERS = [
  { key: "Content-Security-Policy", value: BOOK_CSP },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "no-store, max-age=0" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig = {
  async headers() {
    return [
      {
        source: "/pay/:path*",
        headers: PAY_HEADERS,
      },
      {
        source: "/book/:path*",
        headers: [{ key: "Content-Security-Policy", value: BOOK_CSP }],
      },
      {
        source: "/book",
        headers: [{ key: "Content-Security-Policy", value: BOOK_CSP }],
      },
    ];
  },
};

export default nextConfig;
