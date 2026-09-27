import type { Metadata } from 'next';
import Script from 'next/script';

export const metadata: Metadata = { title: 'Contact form', robots: { index: false } };

/** Hosted lead form: a shareable link, also embeddable in an iframe. Uses the same script as the website embed. */
export default async function HostedFormPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return (
    <main className="min-h-screen bg-paper px-4 py-10">
      <div className="mx-auto max-w-xl rounded-[var(--radius-panel)] border border-line bg-white p-6 shadow-sm sm:p-8">
        <div data-socialpilot-form={/^lf_[A-Za-z0-9_-]{8,40}$/.test(key) ? key : ''} />
      </div>
      <Script src="/embed/form.js" strategy="afterInteractive" />
    </main>
  );
}
