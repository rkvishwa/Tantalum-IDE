import { Suspense } from 'react';
import { DesktopAuthPage } from '@/components/DesktopAuth';

export default function DesktopAuthRoute() {
  return <Suspense><DesktopAuthPage /></Suspense>;
}
