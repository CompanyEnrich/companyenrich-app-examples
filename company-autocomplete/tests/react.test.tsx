// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyAutocomplete, type CompanySelection } from '../src/react/CompanyAutocomplete';
import { deferredFetch, handlerBackedFetch } from './browser-fakes';
import { STRIPE } from './fake-api';
import type { CompanyProfile } from '../src/shared/types';

const STRIPE_PROFILE: CompanyProfile = {
  id: STRIPE.id,
  domain: 'stripe.com',
  name: 'Stripe',
  logoUrl: null,
  industry: 'Financial Services',
  employees: '5K-10K',
  revenue: null,
  foundedYear: 2010,
  country: { code: 'US', name: 'United States' },
  state: null,
  city: null,
  linkedinUrl: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPicker(props: Partial<Parameters<typeof CompanyAutocomplete>[0]> = {}) {
  const onSelect = vi.fn<(selection: CompanySelection) => void>();
  const onClear = vi.fn();
  render(
    <form>
      <CompanyAutocomplete name="companyDomain" debounceMs={20} onSelect={onSelect} onClear={onClear} {...props} />
    </form>,
  );
  const input = screen.getByRole('combobox', { name: 'Company' });
  return { input, onSelect, onClear, user: userEvent.setup() };
}

// Status lines also go to the screen reader live region; match the visible copy.
const visible = { ignore: '[role="status"], script, style' };

async function openSuggestions(user: ReturnType<typeof userEvent.setup>, input: HTMLElement, text = 'stri') {
  await user.type(input, text);
  await screen.findByRole('option', { name: /Stripe/ });
}

describe('<CompanyAutocomplete>', () => {
  it('renders an ARIA combobox wired to its listbox', () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { input } = renderPicker();
    expect(input).toHaveProperty('tagName', 'INPUT');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    const listbox = document.getElementById(input.getAttribute('aria-controls') ?? '');
    expect(listbox?.getAttribute('role')).toBe('listbox');
  });

  it('debounces typing into one request and lists suggestions with logos', async () => {
    const server = handlerBackedFetch();
    vi.stubGlobal('fetch', server.fetch);
    const { input, user } = renderPicker({ debounceMs: 150 });

    await user.type(input, 'stri');
    expect(server.requests).toHaveLength(0);
    await screen.findByRole('option', { name: /Stripe/ });

    expect(server.requests.map((url) => url.searchParams.get('q'))).toEqual(['stri']);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Stripestripe.com', 'Stringeestringee.com', 'Sstrike.mestrike.me']);
    expect(options[0]?.querySelector('img')?.getAttribute('src')).toBe(STRIPE.logoUrl);
    expect(screen.getByRole('status').textContent).toBe('3 companies found. Use the up and down arrows to choose.');
  });

  it('does not search below two characters', async () => {
    const server = handlerBackedFetch();
    vi.stubGlobal('fetch', server.fetch);
    const { input, user } = renderPicker();
    await user.type(input, 's');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.requests).toHaveLength(0);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves the active option with arrows, Home and End, and closes with Escape', async () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { input, user } = renderPicker();
    await openSuggestions(user, input);
    const ids = screen.getAllByRole('option').map((option) => option.id);
    const active = () => input.getAttribute('aria-activedescendant');

    await user.keyboard('{ArrowDown}');
    expect(active()).toBe(ids[0]);
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe(ids[1]);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(active()).toBe(ids[2]); // wraps from the first to the last
    await user.keyboard('{Home}');
    expect(active()).toBe(ids[0]);
    await user.keyboard('{End}');
    expect(active()).toBe(ids[2]);

    await user.keyboard('{Escape}');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(active()).toBeNull();
    expect(input).toHaveProperty('value', 'stri');
    await user.keyboard('{Escape}');
    expect(input).toHaveProperty('value', '');
  });

  it('enriches the company picked with Enter and reports what it cost', async () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { input, onSelect, user } = renderPicker();
    await openSuggestions(user, input);
    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
    const selection = onSelect.mock.calls[0]?.[0];
    expect(selection).toMatchObject({ domain: 'stripe.com', name: 'Stripe', credits: 1, cached: false, error: null });
    expect(selection?.company).toMatchObject({ industry: 'Financial Services', employees: '5K-10K', country: { code: 'US' } });
    expect(input).toHaveProperty('value', 'Stripe');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector<HTMLInputElement>('input[name="companyDomain"]')?.value).toBe('stripe.com');
  });

  it('serves a repeated pick from the browser cache for 0 credits', async () => {
    const server = handlerBackedFetch();
    vi.stubGlobal('fetch', server.fetch);
    const { input, onSelect, user } = renderPicker();
    await openSuggestions(user, input);
    await user.click(screen.getByRole('option', { name: /Stripe/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));

    await user.clear(input);
    await openSuggestions(user, input);
    await user.click(screen.getByRole('option', { name: /Stripe/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2));

    expect(onSelect.mock.calls[1]?.[0]).toMatchObject({ credits: 0, cached: true });
    expect(server.requests.filter((url) => url.searchParams.has('domain'))).toHaveLength(1);
  });

  it('offers "Use <typed domain>" when nothing matches, and handles a company with no data', async () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { input, onSelect, user } = renderPicker();
    await user.type(input, 'https://acme-widgets.io/about');

    const option = await screen.findByRole('option', { name: 'Use “acme-widgets.io”' });
    expect(screen.getByText('No companies match “https://acme-widgets.io/about”.', visible)).toBeTruthy();
    await user.click(option);

    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ domain: 'acme-widgets.io', company: null, credits: 0, error: null });
    expect(screen.getByText('No details found for acme-widgets.io. Fill in the fields yourself.', visible)).toBeTruthy();
  });

  it('suggests typing a website when a name has no matches', async () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { input, user } = renderPicker();
    await user.type(input, 'acme corp');
    expect(await screen.findByText('No companies match “acme corp”. Try the company website, like acme.com.', visible)).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('aborts a stale request and ignores its late answer', async () => {
    const server = deferredFetch();
    vi.stubGlobal('fetch', server.fetch);
    const { input, user } = renderPicker();

    await user.type(input, 'str');
    await waitFor(() => expect(server.pending).toHaveLength(1));
    await user.type(input, 'i');
    await waitFor(() => expect(server.pending).toHaveLength(2));
    expect(server.pending[0]?.signal?.aborted).toBe(true);

    await act(async () => server.pending[1]?.respond({ items: [{ domain: 'stripe.com', name: 'Stripe', logoUrl: null }] }));
    await screen.findByRole('option', { name: /Stripe/ });
    await act(async () => server.pending[0]?.respond({ items: [{ domain: 'stale.example', name: 'Stale', logoUrl: null }] }));

    // "S" is the initials fallback, since this suggestion has no logo.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['SStripestripe.com']);
  });

  it('reports the cost of an enrichment the user moved past, without applying it', async () => {
    const server = deferredFetch();
    vi.stubGlobal('fetch', server.fetch);
    const onCost = vi.fn();
    const { input, onSelect, user } = renderPicker({ onCost });

    await user.type(input, 'stri');
    await waitFor(() => expect(server.pending).toHaveLength(1));
    await act(async () => server.pending[0]?.respond({ items: [{ domain: 'stripe.com', name: 'Stripe', logoUrl: null }] }));
    await user.click(await screen.findByRole('option', { name: /Stripe/ }));
    await waitFor(() => expect(server.pending).toHaveLength(2));
    const enrichment = server.pending[1];
    expect(enrichment?.url.searchParams.get('domain')).toBe('stripe.com');

    // The user keeps typing while the paid lookup is in flight. The server bills
    // it either way, so it is left to finish rather than aborted.
    await user.type(input, 'x');
    expect(enrichment?.signal?.aborted).toBe(false);
    await act(async () => enrichment?.respond({ company: { ...STRIPE_PROFILE }, credits: 1, cached: false }));

    expect(onCost).toHaveBeenCalledWith({ domain: 'stripe.com', credits: 1, cached: false, superseded: true });
    expect(onSelect).not.toHaveBeenCalled();
    expect(input).toHaveProperty('value', 'Stripex');
  });

  it('shows the server error message when suggestions fail', async () => {
    vi.stubGlobal('fetch', handlerBackedFetch({ autocomplete: () => ({ status: 500, body: {}, headers: { 'retry-after': '0' } }) }).fetch);
    const { input, user } = renderPicker();
    await user.type(input, 'stri');
    expect(await screen.findByText('Company lookup failed. Please try again.', visible)).toBeTruthy();
  });

  it('calls onClear when the user edits the text after a pick', async () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { input, onSelect, onClear, user } = renderPicker();
    await openSuggestions(user, input);
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());

    await user.type(input, 'x');
    expect(onClear).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>('input[name="companyDomain"]')?.value).toBe('');
  });

  it('falls back to initials when a logo fails to load', async () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { input, user } = renderPicker();
    await openSuggestions(user, input);
    const stripe = screen.getByRole('option', { name: /Stripe/ });
    fireEvent.error(stripe.querySelector('img') as HTMLImageElement);
    expect(stripe.querySelector('img')).toBeNull();
    expect(stripe.textContent).toBe('SStripestripe.com');
  });
});
