import type { ReactElement } from 'react';
import { QuoteForm } from '@/components/quote-form';

export default function HomePage(): ReactElement {
  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">Hexbound example</p>
        <h1>Order quote</h1>
        <p>
          A reducer-driven checkout draft, a schema-validated server action, and a browser
          connectivity subscription in one small Next.js App Router page.
        </p>
      </header>
      <QuoteForm />
      <footer className="footer">
        <p>
          No database, authentication, or persistence is used. The catalog and quote calculation
          are server-side, and the action returns an explicit display DTO.
        </p>
      </footer>
    </main>
  );
}
