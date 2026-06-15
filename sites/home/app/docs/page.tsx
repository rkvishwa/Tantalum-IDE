import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/Section';

const sections = [
  ['Getting started', 'Create a web account, verify your email, install the desktop IDE, then sign in from the IDE using the web login button.'],
  ['Cloud boards', 'Register supported ESP boards from the desktop app. The web portal can review status, runtime version, provisioning state, and firmware history.'],
  ['Firmware releases', 'Build and upload firmware from the IDE. The web portal can inspect existing releases and queue supported deployments.'],
  ['Agents', 'Use managed or custom model credentials in the IDE. The web portal shows credit usage and recent agent activity.'],
  ['Admin operations', 'Users with the admin role can manage usage, entitlements, app settings, and model pool records from the admin portal.'],
];

export default function DocsPage() {
  return (
    <main className="page doc-layout">
      <aside className="doc-nav">
        {sections.map(([title]) => (
          <a key={title} href={`#${title.toLowerCase().replaceAll(' ', '-')}`}>{title}</a>
        ))}
      </aside>
      <article>
        <PageHeader
          eyebrow="Documentation"
          title="Operate Tantalum from desktop and web"
        />
        {sections.map(([title, body]) => (
          <section className="doc-section" id={title.toLowerCase().replaceAll(' ', '-')} key={title}>
            <Card large>
              <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{title}</h2>
              <p>{body}</p>
            </Card>
          </section>
        ))}
      </article>
    </main>
  );
}
