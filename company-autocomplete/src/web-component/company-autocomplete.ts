// <company-autocomplete> — the same company picker as the React component, as a
// framework-free custom element. Both render CompanyComboboxController.
//
//   <company-autocomplete endpoint="/api/company" name="company"></company-autocomplete>
//
// Attributes (read when the element connects): endpoint, label, name,
// placeholder, min-chars, debounce-ms.
// Events: `company-select` (detail: CompanySelection), `company-clear`, and
// `company-cost` (detail: EnrichmentCost) for every enrichment the server answers.
//
// It renders into the light DOM, so page styles apply (every element has a
// `ca-*` class) and the hidden input submits with the surrounding form.

import { createCompanyClient } from '../client/company-client';
import {
  CompanyComboboxController,
  announcement,
  initials,
  type CompanyOption,
  type CompanySelection,
  type EnrichmentCost,
} from '../client/combobox-controller';

export type { CompanySelection, EnrichmentCost } from '../client/combobox-controller';
export type { CompanyProfile } from '../shared/types';

interface Parts {
  input: HTMLInputElement;
  spinner: HTMLElement;
  popup: HTMLElement;
  listbox: HTMLElement;
  popupMessage: HTMLElement;
  hint: HTMLElement;
  status: HTMLElement;
  hidden: HTMLInputElement | null;
}

let instances = 0;

export class CompanyAutocompleteElement extends HTMLElement {
  #controller: CompanyComboboxController | undefined;
  #unsubscribe: (() => void) | undefined;
  #parts: Parts | undefined;
  #id = '';
  #renderedOptions: CompanyOption[] | undefined;

  connectedCallback(): void {
    this.#id = `company-autocomplete-${++instances}`;
    const controller = new CompanyComboboxController({
      client: createCompanyClient(this.getAttribute('endpoint') ?? '/api/company'),
      minChars: numberAttribute(this, 'min-chars'),
      debounceMs: numberAttribute(this, 'debounce-ms'),
      onSelect: (selection) =>
        this.dispatchEvent(new CustomEvent('company-select', { detail: selection, bubbles: true, composed: true })),
      onClear: () => this.dispatchEvent(new CustomEvent('company-clear', { bubbles: true, composed: true })),
      onCost: (cost) => this.dispatchEvent(new CustomEvent('company-cost', { detail: cost, bubbles: true, composed: true })),
    });
    this.#controller = controller;
    this.#parts = this.#build(controller);
    this.#renderedOptions = undefined;
    this.#unsubscribe = controller.subscribe(() => this.#render());
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#controller?.destroy();
    this.#controller = undefined;
    this.#parts = undefined;
    this.replaceChildren();
  }

  /** The current pick, or null. Handy when reading the form without listening for events. */
  get selection(): CompanySelection | null {
    return this.#controller?.getState().selection ?? null;
  }

  #optionId(index: number): string {
    return `${this.#id}-option-${index}`;
  }

  #build(controller: CompanyComboboxController): Parts {
    const inputId = `${this.#id}-input`;
    const listboxId = `${this.#id}-listbox`;
    const labelText = this.getAttribute('label') ?? 'Company';

    const label = element('label', 'ca-label', labelText);
    label.htmlFor = inputId;

    const input = element('input', 'ca-input');
    Object.assign(input, { id: inputId, type: 'text', autocomplete: 'off', spellcheck: false });
    input.placeholder = this.getAttribute('placeholder') ?? 'Company name or website';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listboxId);
    input.addEventListener('input', () => controller.setInput(input.value));
    input.addEventListener('keydown', (event) => {
      if (controller.handleKey(event.key)) event.preventDefault();
    });
    input.addEventListener('blur', () => controller.close());

    const spinner = element('span', 'ca-spinner');
    spinner.setAttribute('aria-hidden', 'true');

    const listbox = element('ul', 'ca-listbox');
    listbox.id = listboxId;
    listbox.setAttribute('role', 'listbox');
    listbox.setAttribute('aria-label', `${labelText} suggestions`);
    // Keep focus in the input so a click does not blur and close the popup first.
    listbox.addEventListener('mousedown', (event) => event.preventDefault());
    listbox.addEventListener('click', (event) => {
      const index = optionIndex(event.target);
      if (index !== null) void controller.choose(index);
    });
    listbox.addEventListener('mousemove', (event) => {
      const index = optionIndex(event.target);
      if (index !== null) controller.highlight(index);
    });

    const popupMessage = element('p', 'ca-message');
    const popup = element('div', 'ca-popup');
    popup.append(listbox, popupMessage);

    const field = element('div', 'ca-field');
    field.append(input, spinner);

    const hint = element('p', 'ca-hint');
    const status = element('p', 'ca-sr-only');
    status.setAttribute('role', 'status');

    const name = this.getAttribute('name');
    let hidden: HTMLInputElement | null = null;
    if (name) {
      hidden = element('input');
      Object.assign(hidden, { type: 'hidden', name });
    }

    this.replaceChildren(label, field, popup, hint, status, ...(hidden ? [hidden] : []));
    return { input, spinner, popup, listbox, popupMessage, hint, status, hidden };
  }

  #render(): void {
    const parts = this.#parts;
    const state = this.#controller?.getState();
    if (!parts || !state) return;
    const { input, spinner, popup, listbox, popupMessage, hint, status, hidden } = parts;

    // Assigning an unchanged value would move the caret to the end.
    if (input.value !== state.inputValue) input.value = state.inputValue;
    input.setAttribute('aria-expanded', String(state.open));
    if (state.open && state.activeIndex >= 0) {
      input.setAttribute('aria-activedescendant', this.#optionId(state.activeIndex));
    } else {
      input.removeAttribute('aria-activedescendant');
    }
    spinner.hidden = state.status !== 'loading' && state.status !== 'enriching';

    if (state.options !== this.#renderedOptions) {
      listbox.replaceChildren(...state.options.map((option, index) => this.#renderOption(option, index)));
      this.#renderedOptions = state.options;
    }
    listbox.hidden = state.options.length === 0;
    listbox.querySelectorAll<HTMLElement>('[role="option"]').forEach((option, index) => {
      const active = index === state.activeIndex;
      option.setAttribute('aria-selected', String(active));
      option.classList.toggle('ca-option--active', active);
      if (active) option.scrollIntoView?.({ block: 'nearest' });
    });

    // The message shows inside the popup while it is open, and under the input otherwise.
    popup.hidden = !state.open;
    popupMessage.textContent = state.open ? state.message : '';
    popupMessage.hidden = !popupMessage.textContent;
    hint.textContent = state.open ? '' : state.message;
    hint.hidden = !hint.textContent;

    // Only touch the live region when its text changes, to avoid repeat announcements.
    const spoken = announcement(state);
    if (status.textContent !== spoken) status.textContent = spoken;
    if (hidden) hidden.value = state.selection?.domain ?? '';
  }

  #renderOption(option: CompanyOption, index: number): HTMLElement {
    const item = element('li', 'ca-option');
    item.id = this.#optionId(index);
    item.dataset.index = String(index);
    item.setAttribute('role', 'option');

    const fallback = element('span', 'ca-initials', initials(option.name));
    fallback.setAttribute('aria-hidden', 'true');
    let logo: HTMLElement = fallback;
    if (option.logoUrl) {
      const image = element('img', 'ca-logo');
      Object.assign(image, { src: option.logoUrl, alt: '', loading: 'lazy' });
      image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
      logo = image;
    }

    const text = element('span', 'ca-option-text');
    text.append(element('span', 'ca-option-name', option.typed ? `Use “${option.domain}”` : option.name));
    if (!option.typed) text.append(element('span', 'ca-option-domain', option.domain));

    item.append(logo, text);
    return item;
  }
}

// Text goes in with textContent, never innerHTML: names come from an external API.
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function optionIndex(target: EventTarget | null): number | null {
  const option = target instanceof Element ? target.closest<HTMLElement>('[role="option"]') : null;
  return option?.dataset.index ? Number(option.dataset.index) : null;
}

function numberAttribute(host: HTMLElement, name: string): number | undefined {
  const value = host.getAttribute(name)?.trim();
  return value && !Number.isNaN(Number(value)) ? Number(value) : undefined;
}

if (!customElements.get('company-autocomplete')) {
  customElements.define('company-autocomplete', CompanyAutocompleteElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'company-autocomplete': CompanyAutocompleteElement;
  }
  interface HTMLElementEventMap {
    'company-select': CustomEvent<CompanySelection>;
    'company-clear': CustomEvent<null>;
    'company-cost': CustomEvent<EnrichmentCost>;
  }
}
