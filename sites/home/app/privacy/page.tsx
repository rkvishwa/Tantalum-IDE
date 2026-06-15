import { PageHeader } from '@/components/ui/Section';

export default function PrivacyPage() {
  return (
    <main className="page prose">
      <PageHeader eyebrow="Privacy Policy" title="Privacy Policy" />
      <p>Tantalum stores account information, cloud board metadata, firmware release metadata, support requests, and agent usage records needed to operate the service.</p>
      <section className="doc-section">
        <h2>Data collected</h2>
        <p>We collect account identifiers, email address, session metadata, board status, firmware metadata, usage ledger records, and support form content.</p>
      </section>
      <section className="doc-section">
        <h2>Secrets</h2>
        <p>Provider API keys and sensitive board command material are stored through encrypted server-side envelopes or local desktop secret storage where applicable.</p>
      </section>
      <section className="doc-section">
        <h2>Control</h2>
        <p>You can sign out, reset your password, rotate board tokens, and contact support for account or data questions.</p>
      </section>
    </main>
  );
}
