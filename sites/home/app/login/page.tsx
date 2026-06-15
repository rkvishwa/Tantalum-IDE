import { Suspense } from 'react';
import { AuthForm } from '@/components/AuthForms';

export default function LoginPage() {
  return <Suspense><AuthForm mode="login" /></Suspense>;
}
