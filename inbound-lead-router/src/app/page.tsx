import { SignupDemo } from '@/components/SignupDemo';
import { secretConfigured } from '@/server/context';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <div className="space-y-6">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold">Signup demo</h1>
        <p className="mt-2 text-slate-600">
          This form posts to <code className="rounded bg-slate-100 px-1">POST /api/inbound</code>, the same webhook your product would call on every signup. It
          enriches the email&apos;s company, scores it against <code className="rounded bg-slate-100 px-1">config/scoring.json</code>, routes it with{' '}
          <code className="rounded bg-slate-100 px-1">config/routing.json</code>, finds people at tier A accounts and sends the alert.
        </p>
      </div>
      <SignupDemo secretRequired={secretConfigured()} />
    </div>
  );
}
