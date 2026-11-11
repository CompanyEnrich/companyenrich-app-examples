import { autocomplete } from '@/lib/handlers';
import { getRoute } from '@/lib/route';

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  return getRoute(autocomplete, (url) => ({
    kind,
    q: url.searchParams.get('q') ?? '',
    countries: (url.searchParams.get('countries') ?? '').split(',').filter(Boolean),
  }))(request);
}
