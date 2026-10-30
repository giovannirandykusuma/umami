import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { resolvePrivateRender } from '@/lib/analyst-verifier/port.mjs';
import { VerifierCanvas } from './VerifierCanvas';

export const dynamic = 'force-dynamic';

export default async function VerifierCanvasPage() {
  const credential = (await headers()).get('x-verifier-transport');
  if (!credential || !/^[A-Za-z0-9_-]{43}$/.test(credential)) notFound();
  let job;
  try {
    // This is the existing live application authority check (user, task expiry, board and
    // analysis permissions/revisions), not a browser session or an auth-free public route.
    job = await resolvePrivateRender(credential);
  } catch {
    notFound();
  }
  const payload = { scope: job.scope, widgets: job.widgets };
  if (Buffer.byteLength(JSON.stringify(payload)) > 1_100_000) notFound();
  return <VerifierCanvas payload={payload} />;
}
