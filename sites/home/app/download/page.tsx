import { Download, Monitor, Apple, Terminal } from 'lucide-react';
import { config } from '@/lib/config';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/Section';

const downloads = [
  { id: 'windows', name: 'Windows', detail: 'NSIS installer', url: config.downloadUrls.windows, icon: Monitor },
  { id: 'macos', name: 'macOS', detail: 'Zip package', url: config.downloadUrls.macos, icon: Apple },
  { id: 'linux', name: 'Linux', detail: 'AppImage or deb', url: config.downloadUrls.linux, icon: Terminal },
];

export default function DownloadPage() {
  return (
    <main className="page">
      <PageHeader
        eyebrow="Download"
        title="Install Tantalum IDE"
        description="Download links are controlled by deployment environment variables. If a platform link is blank, that build is not published yet."
      />
      <div className="download-grid">
        {downloads.map((item) => {
          const Icon = item.icon;
          return (
            <Card key={item.id} icon={Icon} title={item.name} large>
              <p>{item.detail}</p>
              {item.url ? (
                <Button variant="primary" href={item.url}>
                  <Download size={14} /> Download
                </Button>
              ) : (
                <Badge variant="warning">Not published</Badge>
              )}
            </Card>
          );
        })}
      </div>
      <Card large className="settings-card" style={{ marginTop: 24 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Release notes</h3>
        <p>Version and release notes will appear here when published builds are configured.</p>
      </Card>
    </main>
  );
}
