import { Bot, Cpu, User } from 'lucide-react';
import { SupportForm } from '@/components/SupportForm';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/Section';

export default function SupportPage() {
  return (
    <main className="page">
      <PageHeader
        eyebrow="Support"
        title="Get help with Tantalum"
        description="Use this page for account, cloud board, OTA, and agent support. Authenticated support requests are saved for admin review."
      />
      <div className="section-grid">
        <Card icon={User} title="Account">
          <p>Email verification, password reset, web login, and desktop session handoff.</p>
        </Card>
        <Card icon={Cpu} title="Boards">
          <p>Cloud registration, provisioning, OTA status, and firmware release tracking.</p>
        </Card>
        <Card icon={Bot} title="Agents">
          <p>Credit usage, custom provider credentials, managed model assignment, and threads.</p>
        </Card>
      </div>
      <section className="settings-card" style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Contact support</h2>
        <SupportForm />
      </section>
    </main>
  );
}
