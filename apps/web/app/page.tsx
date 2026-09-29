import type { Metadata } from 'next';
import { Landing } from '@/components/landing';

export const metadata: Metadata = {
  title: { absolute: 'SocialPilot: every client’s social media, run from one board' },
  description: 'AI-drafted posts, client approvals, scheduled publishing, one inbox for comments and messages, and lead capture, for agencies. Runs on Meta’s Muse Spark models.',
};

export default function Home() {
  return <Landing />;
}
