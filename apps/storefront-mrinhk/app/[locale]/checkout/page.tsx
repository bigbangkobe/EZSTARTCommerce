import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, type Locale } from '../../../lib/i18n';
import { pageMetadata } from '../../../lib/seo';
import CheckoutView from './checkout-view';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  return pageMetadata(raw, '/checkout', 'checkout', { index: false });
}

export default async function CheckoutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  return <CheckoutView locale={raw as Locale} />;
}
