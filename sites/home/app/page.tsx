import { Bot, Cloud, Cpu, ShieldCheck, Zap } from 'lucide-react';
import { ProductVisual } from '@/components/ProductVisual';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Eyebrow, Section } from '@/components/ui/Section';

export default function HomePage() {
  return (
    <main>
      <Section>
        <div className="page hero">
          <div className="hero__content">
            <Eyebrow>Desktop control, cloud visibility</Eyebrow>
            <h1>The IDE for connected Arduino and ESP projects</h1>
            <p>
              Build firmware locally, manage cloud boards from the browser, ship OTA releases,
              and keep agent usage visible from one account.
            </p>
            <div className="hero-actions">
              <Button variant="primary" size="md" href="/register">Start free</Button>
              <Button variant="secondary" size="md" href="/download">Download IDE</Button>
            </div>
          </div>
          <ProductVisual />
        </div>
      </Section>

      <Section band>
        <div className="page" style={{ padding: 0 }}>
          <Eyebrow>What you can manage</Eyebrow>
          <h2>One account for boards, firmware, and agents</h2>
          <div className="section-grid">
            <Card icon={Cpu} title="Cloud boards">
              <p>Review registered devices, status, runtime versions, token previews, provisioning state, and firmware releases.</p>
            </Card>
            <Card icon={Cloud} title="OTA releases">
              <p>Track deployed firmware and queue existing releases for supported boards without opening the desktop app.</p>
            </Card>
            <Card icon={Bot} title="Agent usage">
              <p>Monitor managed credits, recent requests, model source settings, and active conversation threads.</p>
            </Card>
          </div>
        </div>
      </Section>

      <Section>
        <div className="page" style={{ padding: '0 0 24px' }}>
          <div className="feature-row">
            <div className="feature-row__content">
              <Eyebrow>Build locally</Eyebrow>
              <h2>Arduino workflow with cloud runtime built in</h2>
              <p>
                Write sketches in a familiar editor, compile with Arduino CLI, and deploy to boards
                with Tantalum Cloud Runtime for heartbeat, OTA, and agent hooks.
              </p>
            </div>
            <div className="feature-row__visual">
              <pre className="code-snippet">
                <code>{`#include <TantalumCloudRuntime.h>

void setup() {
  Tantalum.begin();
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  Tantalum.heartbeat();
  Tantalum.checkForUpdate();
}`}</code>
              </pre>
            </div>
          </div>

          <div className="feature-row feature-row--reverse">
            <div className="feature-row__content">
              <Eyebrow>Ship OTA</Eyebrow>
              <h2>Push firmware from desktop or the web portal</h2>
              <p>
                Upload releases from the IDE, then queue deployments to connected boards.
                Track OTA status and runtime versions from the cloud dashboard.
              </p>
            </div>
            <div className="feature-row__visual">
              <Card icon={Zap} title="OTA pipeline">
                <p>Compile in IDE → upload release → queue deploy → board updates on next heartbeat.</p>
              </Card>
            </div>
          </div>

          <div className="feature-row">
            <div className="feature-row__content">
              <Eyebrow>Agent visibility</Eyebrow>
              <h2>Managed coding agents with usage you can audit</h2>
              <p>
                Fast and deep agent modes run inside the IDE with monthly credits, request history,
                and model settings visible in your account.
              </p>
            </div>
            <div className="feature-row__visual">
              <Card icon={Bot} title="Usage dashboard">
                <p>See remaining credits, recent requests, charged tokens, and active threads at a glance.</p>
              </Card>
            </div>
          </div>
        </div>
      </Section>

      <Section band>
        <div className="page" style={{ padding: 0 }}>
          <Eyebrow>Security baseline</Eyebrow>
          <h2>Web login without desktop passwords</h2>
          <div className="section-grid">
            <Card icon={ShieldCheck} title="Verified accounts">
              <p>Email verification and password reset live on the web portal. Desktop sign-in is blocked until email is verified.</p>
            </Card>
            <Card icon={ShieldCheck} title="Short-lived handoff">
              <p>The IDE receives a one-time grant through a custom protocol callback, then creates its own cloud session.</p>
            </Card>
            <Card icon={ShieldCheck} title="Admin labels">
              <p>Admin pages require the <code>admin</code> role and are enforced by backend functions.</p>
            </Card>
          </div>
        </div>
      </Section>

      <Section band accent>
        <div className="page band__cta" style={{ padding: 0 }}>
          <div>
            <Eyebrow>Get started</Eyebrow>
            <h2>Download Tantalum IDE today</h2>
            <p style={{ margin: '8px 0 0' }}>Free Hobby tier. Cloud boards and agents included.</p>
          </div>
          <div className="hero-actions" style={{ marginTop: 0 }}>
            <Button variant="primary" size="md" href="/download">Download</Button>
            <Button variant="secondary" size="md" href="/register">Create account</Button>
          </div>
        </div>
      </Section>
    </main>
  );
}
