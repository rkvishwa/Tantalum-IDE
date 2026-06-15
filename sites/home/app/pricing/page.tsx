import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/Section';

const tiers = [
  { name: 'Hobby', price: 'Free', active: true, features: ['Cloud board dashboard', 'Desktop OTA workflows', 'Managed agent credits', 'Community support'] },
  { name: 'Pro', price: '', active: false, features: ['Higher usage limits', 'Team workflow support', 'Priority issue routing', 'Advanced deployment controls'] },
  { name: 'Max', price: '', active: false, features: ['Largest managed usage pool', 'Fleet-oriented controls', 'Expanded admin reporting', 'Dedicated rollout guidance'] },
];

export default function PricingPage() {
  return (
    <main className="page">
      <PageHeader
        eyebrow="Pricing"
        title="Start with Hobby"
        description="Only the free Hobby tier is active right now. Pro and Max are reserved for later and intentionally have no public pricing yet."
      />
      <div className="price-grid">
        {tiers.map((tier) => (
          <article
            key={tier.name}
            className={['settings-card', 'price-card', !tier.active ? 'price-card--muted' : ''].filter(Boolean).join(' ')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ margin: 0 }}>{tier.name}</h3>
              {tier.active ? <Badge variant="success">Active</Badge> : <Badge>Coming later</Badge>}
            </div>
            <strong>{tier.price || '\u00a0'}</strong>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-soft)', lineHeight: 1.8 }}>
              {tier.features.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
            {tier.active ? (
              <Button variant="primary" href="/register">Get started</Button>
            ) : (
              <Button variant="secondary" disabled>Coming later</Button>
            )}
          </article>
        ))}
      </div>
    </main>
  );
}
