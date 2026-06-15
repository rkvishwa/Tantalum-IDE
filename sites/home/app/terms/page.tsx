import { PageHeader } from '@/components/ui/Section';

export default function TermsPage() {
  return (
    <main className="page prose">
      <PageHeader eyebrow="Terms and Conditions" title="Terms and Conditions" />
      <section className="doc-section">
        <h2>Use of service</h2>
        <p>Tantalum is provided for developing and operating firmware workflows. You are responsible for code deployed to your devices and connected systems.</p>
      </section>
      <section className="doc-section">
        <h2>Cloud features</h2>
        <p>Cloud boards, OTA release tracking, and managed agents depend on cloud service availability and configured account limits.</p>
      </section>
      <section className="doc-section">
        <h2>Plans</h2>
        <p>The Hobby tier is free while Pro and Max remain unpublished. Paid plan availability and pricing may be added later.</p>
      </section>
    </main>
  );
}
