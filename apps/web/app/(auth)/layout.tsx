import type { ReactNode } from 'react';

/** Example strips shown beside the auth forms: the product's own vocabulary, not marketing copy. */
const STRIPS = [
  { tone: 'strip-clearance', title: 'Published to Instagram', meta: "Bella's Bakery, 09:00" },
  { tone: 'strip-runway', title: 'Caption waiting for client approval', meta: 'Summit Fitness, due today' },
  { tone: 'strip-sky', title: 'Reply sent: “We open at 8am on Saturdays”', meta: 'Answered from the FAQ' },
  { tone: 'strip-alert', title: 'Refund request handed to a person', meta: 'AI replies paused for this chat' },
  { tone: 'strip-clearance', title: 'New lead: 40 cinnamon buns for an office party', meta: 'WhatsApp, quote requested' },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <aside className="relative hidden flex-col justify-between bg-rail p-10 text-rail-ink lg:flex">
        <div className="text-lg font-semibold text-white">SocialPilot</div>
        <div>
          <h1 className="max-w-md text-4xl font-semibold leading-tight text-white">Every client’s channels, on one board.</h1>
          <p className="mt-4 max-w-md text-rail-ink">Plan posts, get sign-off, publish on schedule and answer customers — with AI drafting and people deciding.</p>
          <ul className="mt-10 max-w-md space-y-2" aria-label="Example activity">
            {STRIPS.map((s) => (
              <li key={s.title} className={`strip ${s.tone} rounded-r-md bg-rail-active px-4 py-2.5`}>
                <p className="text-sm text-white">{s.title}</p>
                <p className="text-xs text-rail-ink">{s.meta}</p>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-rail-ink">Connects through each platform’s official API. No passwords stored.</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
