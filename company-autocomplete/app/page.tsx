import { SignupForm } from './signup-form';

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:py-16">
      <header className="mb-8 max-w-2xl">
        <p className="text-sm font-medium text-indigo-600">CompanyEnrich example</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Company autocomplete</h1>
        <p className="mt-3 text-slate-600">
          Type a company name or paste its website. Suggestions with logos come from the free autocomplete endpoint;
          picking one enriches the company once and fills in industry, size and country. Edit anything that was filled
          in, and it stays yours.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          Suggestions match the start of a company&apos;s domain, so <kbd className="font-mono">stri</kbd> finds Stripe
          and <kbd className="font-mono">open ai</kbd> finds OpenAI.{' '}
          <a className="text-indigo-600 underline underline-offset-2" href="https://docs.companyenrich.com">
            API docs
          </a>
        </p>
      </header>
      <SignupForm />
    </main>
  );
}
