// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/web-component/company-autocomplete';
import type { CompanySelection, EnrichmentCost } from '../src/web-component/company-autocomplete';
import { handlerBackedFetch } from './browser-fakes';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function mount() {
  document.body.innerHTML = `
    <form>
      <company-autocomplete endpoint="/api/company" name="companyDomain" label="Employer" debounce-ms="20"></company-autocomplete>
    </form>`;
  const element = document.querySelector('company-autocomplete');
  if (!element) throw new Error('not mounted');
  const input = screen.getByRole('combobox', { name: 'Employer' });
  return { element, input, user: userEvent.setup() };
}

describe('<company-autocomplete>', () => {
  it('renders an ARIA combobox and listbox in the light DOM', () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { input } = mount();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(input.getAttribute('aria-controls') ?? '')?.getAttribute('role')).toBe('listbox');
  });

  it('emits company-select with the enriched company after a keyboard pick', async () => {
    const server = handlerBackedFetch();
    vi.stubGlobal('fetch', server.fetch);
    const { element, input, user } = mount();
    const events: CompanySelection[] = [];
    const costs: EnrichmentCost[] = [];
    element.addEventListener('company-select', (event) => events.push(event.detail));
    element.addEventListener('company-cost', (event) => costs.push(event.detail));

    await user.type(input, 'stri');
    await screen.findByRole('option', { name: /Stripe/ });
    expect(server.requests.map((url) => url.searchParams.get('q'))).toEqual(['stri']);
    expect(screen.getAllByRole('option')).toHaveLength(3);

    await user.keyboard('{ArrowDown}');
    const first = screen.getAllByRole('option')[0];
    expect(input.getAttribute('aria-activedescendant')).toBe(first?.id);
    expect(first?.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ domain: 'stripe.com', credits: 1, cached: false });
    expect(costs).toEqual([{ domain: 'stripe.com', credits: 1, cached: false, superseded: false }]);
    expect(events[0]?.company).toMatchObject({ industry: 'Financial Services', employees: '5K-10K' });
    expect(element.selection?.domain).toBe('stripe.com');
    expect((input as HTMLInputElement).value).toBe('Stripe');
    expect(document.querySelector<HTMLInputElement>('input[name="companyDomain"]')?.value).toBe('stripe.com');
  });

  it('bubbles company-select to the form, and emits company-clear when the text changes', async () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { input, user } = mount();
    const form = document.querySelector('form');
    const selected = vi.fn();
    const cleared = vi.fn();
    form?.addEventListener('company-select', selected);
    form?.addEventListener('company-clear', cleared);

    await user.type(input, 'stri');
    await user.click(await screen.findByRole('option', { name: /Stripe/ }));
    await waitFor(() => expect(selected).toHaveBeenCalledOnce());

    await user.type(input, 'x');
    expect(cleared).toHaveBeenCalledOnce();
  });

  it('cleans up when removed from the page', async () => {
    vi.stubGlobal('fetch', handlerBackedFetch().fetch);
    const { element } = mount();
    element.remove();
    expect(element.childElementCount).toBe(0);
    expect(element.selection).toBeNull();
  });
});
