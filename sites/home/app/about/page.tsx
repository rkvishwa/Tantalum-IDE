import { Cloud, Cpu, Shield } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/Section';

export default function AboutPage() {
  return (
    <main className="page">
      <PageHeader
        eyebrow="About"
        title="Arduino development with cloud accountability"
        description="Tantalum IDE combines local hardware tooling with cloud-backed boards, firmware release tracking, and managed coding agents. The web portal gives users and admins visibility without moving serial, compile, and flash workflows out of the desktop app."
      />
      <div className="section-grid">
        <Card icon={Cpu} title="Local first">
          <p>USB, serial, compile, and flash flows stay on the machine connected to the board.</p>
        </Card>
        <Card icon={Cloud} title="Cloud aware">
          <p>Board state, firmware releases, and agent usage are available from the browser.</p>
        </Card>
        <Card icon={Shield} title="Admin ready">
          <p>Usage, global settings, and account controls are handled through secured backend functions.</p>
        </Card>
      </div>
    </main>
  );
}
