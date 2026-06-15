import { Suspense } from 'react';
import { AuthForm } from '@/components/AuthForms';

export default function RegisterPage() {
  return <Suspense><AuthForm mode="register" /></Suspense>;
}
